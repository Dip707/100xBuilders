import { z } from "zod";
import { BrowserToolkit } from "../browser/toolkit.js";
import { FlowSchema, StepSchema, outputDir, type Flow, type RunState, type RunUpdate, type SiteMap } from "../state.js";
import { writeOutput } from "../output.js";
import { now, type NodeDeps } from "./deps.js";

export const PlanOutputSchema = z.object({ flows: z.array(FlowSchema) });
/** Same as FlowSchema but allows an empty steps array, which means "could not be repaired". */
export const RepairedFlowSchema = FlowSchema.extend({ steps: z.array(StepSchema) });

/**
 * Everything a plan repair is forbidden to touch: a repair may change how a flow *navigates*,
 * never what it *proves* or which flow it is.
 *
 * `plan-repair.md` already asks for this ("Do not change the expectations"), but a prompt is a
 * request, not a guard - the same reason `guardExpects` is enforced in code rather than
 * trusted to `heal.md`. Left unchecked, a repair that rewrites `expected` manufactures an
 * assertion nothing on the page satisfies: the runner fails it, the classifier calls it a
 * defect, and the final report names an application bug that was never there. For a tool whose
 * whole claim is telling a broken test from a broken app, a fabricated defect is as damaging
 * as a hidden one.
 */
const REPAIR_IMMUTABLE = ["id", "title", "category", "priority", "preconditions", "expected", "source"] as const;

type RepairImmutable = (typeof REPAIR_IMMUTABLE)[number];

/** Which immutable fields a repair tried to move. Empty means the repair only touched steps. */
export function driftedFields(before: Flow, after: Flow): RepairImmutable[] {
  return REPAIR_IMMUTABLE.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function siteMapSummary(map: SiteMap): string {
  const lines: string[] = [`origin: ${map.origin}`, `loginPath: ${map.loginPath ?? "none"}`];
  for (const p of Object.values(map.pages)) {
    lines.push(`\n## ${p.path} (${p.title})${p.gated ? " [GATED: requires login]" : ""}`);
    for (const f of p.forms) lines.push(`form ${f.id}: fields ${f.fields.map((x) => `${x.role} "${x.name}"${x.required ? " required" : ""} type=${x.type}`).join(", ")}; submit ${f.submit ? `button "${f.submit.name}"` : "none"}`);
    if (p.buttons.length) lines.push(`buttons: ${p.buttons.map((b) => `"${b.name}"`).join(", ")}`);
    if (p.links.length) lines.push(`links: ${p.links.map((l) => `"${l.text}" -> ${new URL(l.href).pathname}`).join(", ")}`);
  }
  return lines.join("\n");
}

export function buildPlanInput(state: RunState): string {
  const parts = [
    `MAX_FLOWS: ${state.maxFlows}`,
    state.intent ? `INTENT: ${state.intent}` : "INTENT: none",
    state.credentials ? `CREDENTIALS: username "${state.credentials.username}" password "${state.credentials.password}"` : "CREDENTIALS: none",
    state.coverage?.gaps.length ? `GAPS TO CLOSE:\n${state.coverage.gaps.map((g) => `- ${g.kind} ${g.target ?? g.requirement ?? ""}: ${g.suggest}`).join("\n")}` : "",
    state.plan.length ? `EXISTING FLOWS (keep the ones that are still valid, add new ones for the gaps):\n${JSON.stringify(state.plan)}` : "",
    state.prdText ? `PRD:\n${state.prdText}` : "",
    `SITE MAP:\n${siteMapSummary(state.siteMap!)}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export async function dryWalk(kit: BrowserToolkit, flow: Flow, siteMap: SiteMap): Promise<{ ok: true } | { ok: false; step: number; snapshot: string }> {
  const page = await kit.newPage();
  try {
    if (flow.preconditions.includes("logged_in")) {
      for (const s of siteMap.loginSteps) if (!(await kit.act(page, s))) return { ok: false, step: -1, snapshot: await kit.snapshot(page) };
    }
    for (let i = 0; i < flow.steps.length; i++) {
      if (!(await kit.act(page, flow.steps[i]))) return { ok: false, step: i, snapshot: await kit.snapshot(page) };
    }
    return { ok: true };
  } finally {
    await page.close();
  }
}

export function renderPlanMd(flows: Flow[]): string {
  const byCat = new Map<string, Flow[]>();
  for (const f of flows) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f]);
  const out = ["# Test plan", "", `${flows.length} flows.`, ""];
  for (const [cat, list] of byCat) {
    out.push(`## ${cat}`, "");
    for (const f of list) {
      out.push(`### ${f.id}: ${f.title}`, "", `Priority ${f.priority}. Source ${f.source}. Preconditions: ${f.preconditions.join(", ") || "none"}.`, "");
      f.steps.forEach((s, i) => out.push(`${i + 1}. ${s.action} ${s.target ?? `${s.role} "${s.name}"`}${s.value ? ` = "${s.value}"` : ""}`));
      out.push("", "Expected:", "");
      for (const e of f.expected) out.push(`- ${e.type} ${e.role ?? ""} ${e.name ?? ""} ${e.text_contains ?? e.value ?? ""}`.replace(/\s+/g, " ").trim());
      out.push("");
    }
  }
  return out.join("\n");
}

export async function planNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "plan" });
  let llmCalls = state.llmCalls;
  const out = await deps.llm.complete({ prompt: "plan", input: buildPlanInput(state), schema: PlanOutputSchema, effort: "high" });
  llmCalls++;
  const flows = out.flows.slice(0, state.maxFlows);
  deps.bus.log("planner", `LLM proposed ${flows.length} flows`, { ids: flows.map((f) => f.id) });

  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent: "planner", screenshotDir: outputDir(state.runId) + "traces/plan" });
  const kept: Flow[] = [];
  const unresolved: string[] = [];
  try {
    for (const flow of flows) {
      let result = await dryWalk(kit, flow, state.siteMap!);
      let current = flow;
      if (!result.ok && result.step >= 0) {
        deps.bus.log("planner", `flow ${flow.id} step ${result.step} unresolved, asking for repair`);
        const repaired = await deps.llm.complete({
          prompt: "plan-repair",
          input: `FLOW:\n${JSON.stringify(flow)}\nFAILING_STEP: ${result.step}\nSNAPSHOT:\n${result.snapshot}`,
          schema: RepairedFlowSchema,
          effort: "medium",
        });
        llmCalls++;
        if (repaired.steps.length > 0) {
          // Take the steps and nothing else, so a repair cannot smuggle in a new assertion.
          const drifted = driftedFields(flow, repaired);
          if (drifted.length) {
            deps.bus.decision({
              node: "plan",
              reason: `flow ${flow.id}: plan-repair also rewrote ${drifted.join(", ")}; discarded that and kept only the repaired steps`,
              evidence: drifted.map((k) => `${k}: ${JSON.stringify(flow[k])} -> ${JSON.stringify(repaired[k])}`),
              next: "continue",
              at: now(),
            });
          }
          current = { ...flow, steps: repaired.steps };
          result = await dryWalk(kit, current, state.siteMap!);
        }
      }
      if (result.ok) kept.push(current);
      else {
        unresolved.push(flow.id);
        deps.bus.decision({ node: "plan", reason: `dropped flow ${flow.id}: step could not be resolved on the live page`, evidence: [flow.title], next: "continue", at: now() });
      }
    }
  } finally {
    await kit.close();
  }
  writeOutput(state.runId, "plan.json", kept);
  writeOutput(state.runId, "plan.md", renderPlanMd(kept));
  deps.bus.emit({ type: "node_end", node: "plan", data: { flows: kept.length, dropped: unresolved.length } });
  return { plan: kept, planIterations: state.planIterations + 1, llmCalls, unresolvedFlows: unresolved };
}
