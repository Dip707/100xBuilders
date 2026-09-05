import { z } from "zod";
import { BrowserToolkit } from "../browser/toolkit.js";
import { FlowInputSchema, StepSchema, outputDir, type Flow, type RunState, type RunUpdate, type SiteMap } from "../state.js";
import { writeOutput } from "../output.js";
import { pathOf } from "./explore.js";
import { now, type NodeDeps } from "./deps.js";

export const PlanOutputSchema = z.object({ flows: z.array(FlowInputSchema) });
/** Same as the model-facing flow but allows an empty steps array, which means "could not be repaired". */
export const RepairedFlowSchema = FlowInputSchema.extend({ steps: z.array(StepSchema) });

/**
 * Names in first-seen order, a repeated one written once with its count: a product grid lists
 * "Add to cart" six times, and the planner needs to know it is one control per item rather than
 * six distinct buttons - a step naming it acts on the first.
 */
export function collapse(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `"${n}" (x${c})` : `"${n}"`)).join(", ");
}

function siteMapSummary(map: SiteMap): string {
  const lines: string[] = [`origin: ${map.origin}`, `loginPath: ${map.loginPath ?? "none"}`];
  for (const p of Object.values(map.pages)) {
    lines.push(`\n## ${p.path} (${p.title})${p.gated ? " [GATED: requires login]" : ""}`);
    for (const f of p.forms) lines.push(`form ${f.id}: fields ${f.fields.map((x) => `${x.role} "${x.name}"${x.required ? " required" : ""} type=${x.type}`).join(", ")}; submit ${f.submit ? `button "${f.submit.name}"` : "none"}`);
    if (p.buttons.length) lines.push(`buttons: ${collapse(p.buttons.map((b) => b.name))}`);
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

/**
 * Walks the flow on the live app and reports whether every step resolved, plus the routes the
 * flow was on after each of its own steps. The login fixture's landing page is not one of them:
 * every signed-in flow starts there, and crediting it would make the entrance look tested by
 * flows that only pass through.
 */
export type WalkResult = { ok: true; visits: string[] } | { ok: false; step: number; snapshot: string; error?: string };

export async function dryWalk(kit: BrowserToolkit, flow: Flow, siteMap: SiteMap): Promise<WalkResult> {
  const page = await kit.newPage();
  try {
    if (flow.preconditions.includes("logged_in")) {
      for (const s of siteMap.loginSteps) if (!(await kit.act(page, s))) return { ok: false, step: -1, snapshot: await kit.snapshot(page) };
    }
    const visits: string[] = [];
    for (let i = 0; i < flow.steps.length; i++) {
      if (!(await kit.act(page, flow.steps[i]))) return { ok: false, step: i, snapshot: await kit.snapshot(page) };
      const at = pathOf(page.url());
      if (visits[visits.length - 1] !== at) visits.push(at);
    }
    return { ok: true, visits };
  } finally {
    await page.close();
  }
}

/**
 * A dry walk that throws - a page that never loads, a browser that went away - is retried once
 * and then reported as a failed walk for that flow alone. Whatever went wrong with one flow's
 * page is no reason to abandon the eleven others, and no reason to end the run with no tests.
 */
async function walkSafely(kit: BrowserToolkit, flow: Flow, siteMap: SiteMap, deps: NodeDeps): Promise<WalkResult> {
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await dryWalk(kit, flow, siteMap);
    } catch (e) {
      error = (e as Error).message.split("\n")[0];
      deps.bus.log("planner", `dry walk of ${flow.id} failed: ${error}; ${attempt === 0 ? "retrying once" : "giving up on it"}`);
    }
  }
  return { ok: false, step: -1, snapshot: "", error };
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
      let result = await walkSafely(kit, flow, state.siteMap!, deps);
      let current: Flow = flow;
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
          current = repaired as Flow;
          result = await walkSafely(kit, current, state.siteMap!, deps);
        }
      }
      if (result.ok) kept.push({ ...current, visits: result.visits });
      else {
        unresolved.push(flow.id);
        const why = !result.ok && result.error ? `its page could not be walked (${result.error})` : "step could not be resolved on the live page";
        deps.bus.decision({ node: "plan", reason: `dropped flow ${flow.id}: ${why}`, evidence: [flow.title], next: "continue", at: now() });
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
