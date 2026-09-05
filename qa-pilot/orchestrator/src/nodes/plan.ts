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

/**
 * The phase a planner log belongs to, carried on the log's payload.
 *
 * The node writes nothing until it is finished, and it is the slowest stretch of a run:
 * roughly a minute inside one LLM call and then a minute or two walking every proposed
 * flow on the live app. Without a phase on the way through, the screen watching this node
 * cannot tell drafting from validating, or either from a hang, so it shows an empty plan
 * for two minutes and reads as broken. Everything the Test coverage screen says while the
 * plan is being written is derived from these.
 */
export type PlannerPhase = "drafting" | "drafted" | "validating" | "repairing" | "validated";

export async function planNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "plan" });
  let llmCalls = state.llmCalls;
  const pages = Object.values(state.siteMap!.pages);
  const forms = pages.reduce((n, p) => n + p.forms.length, 0);
  const gaps = state.coverage?.gaps.length ?? 0;
  deps.bus.log(
    "planner",
    gaps
      ? `rewriting the plan to close ${gaps} coverage ${gaps === 1 ? "gap" : "gaps"}`
      : `reading the site map: ${pages.length} ${pages.length === 1 ? "page" : "pages"}, ${forms} ${forms === 1 ? "form" : "forms"}`,
    { phase: "drafting", pages: pages.length, forms, gaps, maxFlows: state.maxFlows, iteration: state.planIterations + 1, routes: pages.map((p) => p.path) },
  );
  const out = await deps.llm.complete({ prompt: "plan", input: buildPlanInput(state), schema: PlanOutputSchema, effort: "high" });
  llmCalls++;
  const flows = out.flows.slice(0, state.maxFlows);
  // `ids` predates the phases and other readers still take it; the richer `flows` is what
  // lets a watching screen name each flow before its dry walk has decided anything.
  deps.bus.log("planner", `LLM proposed ${flows.length} flows`, {
    phase: "drafted",
    ids: flows.map((f) => f.id),
    flows: flows.map((f) => ({ id: f.id, title: f.title, category: f.category, priority: f.priority })),
  });

  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent: "planner", screenshotDir: outputDir(state.runId) + "traces/plan" });
  const kept: Flow[] = [];
  const unresolved: string[] = [];
  try {
    for (const [index, flow] of flows.entries()) {
      deps.bus.log("planner", `walking ${flow.id} on the live app`, { phase: "validating", flow: flow.id, title: flow.title, index: index + 1, total: flows.length });
      let result = await walkSafely(kit, flow, state.siteMap!, deps);
      let current: Flow = flow;
      if (!result.ok && result.step >= 0) {
        deps.bus.log("planner", `flow ${flow.id} step ${result.step} unresolved, asking for repair`, { phase: "repairing", flow: flow.id, step: result.step });
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
          result = await walkSafely(kit, current, state.siteMap!, deps);
        }
      }
      deps.bus.log("planner", `${result.ok ? "kept" : "dropped"} ${flow.id}`, { phase: "validated", flow: flow.id, ok: result.ok });
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
