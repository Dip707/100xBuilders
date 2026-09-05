import { z } from "zod";
import type { CoverageVerdict, Flow, RunState, RunUpdate, SiteMap } from "../state.js";
import { readOutput, writeOutput } from "../output.js";
import { nameSimilarity } from "../browser/snapshot.js";
import { now, type NodeDeps } from "./deps.js";

export const PrdRequirementsSchema = z.object({ requirements: z.array(z.string()) });
export const PrdMatrixSchema = z.object({ matrix: z.array(z.object({ requirement: z.string(), flow_ids: z.array(z.string()) })) });

export const COVERAGE_THRESHOLD = 0.75;
export const MAX_PLAN_ITERATIONS = 3;
/** How much a re-plan must move the score to be worth another planning call. */
export const STALL_EPSILON = 0.01;

/**
 * Whether re-planning has stopped paying for itself.
 *
 * The gap loop assumes each iteration tells the planner something it did not know. When two
 * consecutive iterations land on the same score, that assumption has failed: the planner has
 * converged on what the site map lets it see, and further iterations spend a `plan` call - the
 * most expensive one in the pipeline - to reproduce the same gaps. Stopping early and carrying
 * the unclosed gaps into the report is both cheaper and more honest than grinding to
 * MAX_PLAN_ITERATIONS and presenting the result as if the loop had finished its work.
 */
export function replanStalled(scores: number[]): boolean {
  if (scores.length < 2) return false;
  return scores[scores.length - 1] - scores[scores.length - 2] <= STALL_EPSILON;
}

/**
 * Everything a flow says about itself: its title, the elements its steps touch, and what it
 * asserts. Intent coverage used to look only at titles, which scores a flow named "Place order"
 * as no coverage at all for the intent "focus on checkout" even though every one of its steps
 * runs through /checkout.
 */
function flowText(f: Flow): string {
  return [
    f.title,
    ...f.steps.map((s) => `${s.name ?? ""} ${s.target ?? ""}`),
    ...f.expected.map((e) => `${e.name ?? ""} ${e.text_contains ?? ""} ${e.value ?? ""}`),
  ].join(" ").toLowerCase();
}

/** A scoping word counts as covered by a substring hit, or by a near-miss on any single token. */
function intentCovered(word: string, flows: Flow[]): boolean {
  return flows.some((f) => {
    const text = flowText(f);
    if (text.includes(word)) return true;
    return text.split(/[^a-z0-9]+/).some((tok) => tok.length > 3 && nameSimilarity(tok, word) >= 0.8);
  });
}

type Gap = CoverageVerdict["gaps"][number];

const touches = (f: Flow, path: string) => f.steps.some((s) => s.action === "goto" && s.target === path) || f.title.toLowerCase().includes(path.replace(/^\//, "").toLowerCase());
const isEmptySubmit = (f: Flow) => /empty|blank|required|without|no input|missing/i.test(f.title);

export function scoreCoverage(siteMap: SiteMap, flows: Flow[], opts: { intent?: string; prdRequirements?: string[]; prdMatrix?: Record<string, string[]> }): CoverageVerdict {
  const gaps: Gap[] = [];
  const checks: Record<string, number> = {};
  const weights: Record<string, number> = {};

  // 1. forms: happy + negative + empty submit
  const forms = Object.values(siteMap.pages).flatMap((p) => p.forms.map((f) => ({ path: p.path, id: f.id })));
  if (forms.length) {
    let pass = 0;
    for (const form of forms) {
      const on = flows.filter((f) => touches(f, form.path));
      const happy = on.some((f) => f.category === "happy");
      const negative = on.some((f) => f.category === "negative" && !isEmptySubmit(f));
      const empty = on.some((f) => isEmptySubmit(f));
      if (!happy) gaps.push({ kind: "missing_happy", target: `form:${form.path}`, suggest: `submit ${form.path} form with valid data and verify success` });
      if (!negative) gaps.push({ kind: "missing_negative", target: `form:${form.path}`, suggest: `submit ${form.path} form with invalid data and verify the error` });
      if (!empty) gaps.push({ kind: "missing_empty_submit", target: `form:${form.path}`, suggest: `submit ${form.path} form empty and verify validation` });
      pass += [happy, negative, empty].filter(Boolean).length / 3;
    }
    checks.forms = pass / forms.length;
    weights.forms = 0.3;
  }

  // 2. gated routes have an authz flow
  const gated = Object.values(siteMap.pages).filter((p) => p.gated);
  if (gated.length) {
    let pass = 0;
    for (const p of gated) {
      const ok = flows.some((f) => f.category === "authz" && touches(f, p.path));
      if (ok) pass++;
      else gaps.push({ kind: "missing_authz", target: p.path, suggest: `visit ${p.path} logged out and expect redirect to ${siteMap.loginPath ?? "login"}` });
    }
    checks.authz = pass / gated.length;
    weights.authz = 0.2;
  }

  // 3. PRD requirements
  if (opts.prdRequirements?.length) {
    let pass = 0;
    for (const r of opts.prdRequirements) {
      const covered = (opts.prdMatrix?.[r] ?? []).some((id) => flows.some((f) => f.id === id));
      if (covered) pass++;
      else gaps.push({ kind: "prd_uncovered", requirement: r, suggest: `add a flow verifying "${r}"` });
    }
    checks.prd = pass / opts.prdRequirements.length;
    weights.prd = 0.2;
  }

  // 4. intent keywords
  if (opts.intent) {
    const words = opts.intent.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["focus", "with", "and", "the", "on"].includes(w));
    if (words.length) {
      const hit = words.filter((w) => intentCovered(w, flows));
      checks.intent = hit.length / words.length;
      weights.intent = 0.1;
      for (const w of words) if (!hit.includes(w)) gaps.push({ kind: "intent_uncovered", target: w, suggest: `no flow touches "${w}" in its title, steps or assertions; add one` });
    }
  }

  // 5. category mix
  const nonHappy = flows.filter((f) => ["negative", "edge", "error_state"].includes(f.category)).length;
  const mix = flows.length ? nonHappy / flows.length : 0;
  checks.mix = Math.min(1, mix / 0.4);
  weights.mix = 0.2;
  if (mix < 0.4) gaps.push({ kind: "category_mix", suggest: `only ${(mix * 100).toFixed(0)}% of flows are negative/edge/error_state; add more` });

  // 6. error states. `mix` counts error_state flows towards a ratio, so a plan can satisfy it
  // with negative flows alone and never once ask what the app does when a request fails. That
  // is a different question from invalid input: a validation error is the app working, a failed
  // request is the app under duress, and only the second reveals whether a failure is surfaced
  // or silently swallowed. Scored only where there is something to fail - a form to submit.
  if (forms.length) {
    const hasErrorState = flows.some((f) => f.category === "error_state");
    checks.errors = hasErrorState ? 1 : 0;
    weights.errors = 0.15;
    if (!hasErrorState) gaps.push({ kind: "missing_error_state", suggest: "no flow exercises a failing request; add one that drives a server or network error and verifies the app surfaces it rather than appearing to succeed" });
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const score = Object.entries(checks).reduce((acc, [k, v]) => acc + v * weights[k], 0) / totalWeight;

  const untested_risk = Object.values(siteMap.pages)
    .filter((p) => p.forms.length && !flows.some((f) => touches(f, p.path)))
    .map((p) => ({ flow: p.path, reason: "form discovered but no flow touches it", risk: "medium" as const }));

  return { score: Math.round(score * 100) / 100, gaps, untested_risk, checks, prdRequirements: opts.prdRequirements ?? [], prdMatrix: opts.prdMatrix ?? {} };
}

export async function coverageNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "evaluate_coverage" });
  let llmCalls = state.llmCalls;
  let prdRequirements = state.coverage?.prdRequirements ?? [];
  const prdMatrix: Record<string, string[]> = {};
  if (state.prdText) {
    if (state.coverage === undefined) {
      try {
        const r = await deps.llm.complete({ prompt: "prd-requirements", input: state.prdText, schema: PrdRequirementsSchema, effort: "medium" });
        llmCalls++;
        prdRequirements = r.requirements;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.bus.emit({ type: "error", node: "evaluate_coverage", message });
        deps.bus.log("evaluator", `PRD analysis unavailable: ${message}; scoring without PRD`);
      }
    }
    if (prdRequirements.length) {
      try {
        const m = await deps.llm.complete({
          prompt: "prd-matrix",
          input: `REQUIREMENTS:\n${prdRequirements.map((r) => `- ${r}`).join("\n")}\n\nFLOWS:\n${state.plan.map((f) => `- ${f.id}: ${f.title} | steps: ${f.steps.map((s) => `${s.action} ${s.name ?? s.target ?? ""}`).join(", ")}`).join("\n")}`,
          schema: PrdMatrixSchema,
          effort: "medium",
        });
        llmCalls++;
        for (const row of m.matrix) prdMatrix[row.requirement] = row.flow_ids;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.bus.emit({ type: "error", node: "evaluate_coverage", message });
        deps.bus.log("evaluator", `PRD analysis unavailable: ${message}; scoring without PRD`);
      }
    }
  }
  const coverage = scoreCoverage(state.siteMap!, state.plan, { intent: state.intent, prdRequirements, prdMatrix });
  const history = JSON.parse(readOutput(state.runId, "coverage.json") ?? "[]") as unknown[];
  history.push({ iteration: state.planIterations, ...coverage });
  writeOutput(state.runId, "coverage.json", history);
  deps.bus.log("evaluator", `coverage score ${coverage.score} with ${coverage.gaps.length} gaps`, coverage.checks);
  deps.bus.emit({ type: "node_end", node: "evaluate_coverage", data: { score: coverage.score, gaps: coverage.gaps.length } });
  return { coverage, llmCalls };
}

export function afterCoverage(state: RunState, deps: NodeDeps): "generate" | "plan" {
  const score = state.coverage!.score;
  const gaps = state.coverage!.gaps.map((g) => `${g.kind} ${g.target ?? g.requirement ?? ""}`.trim());
  const scores = (JSON.parse(readOutput(state.runId, "coverage.json") ?? "[]") as { score: number }[]).map((h) => h.score);
  const stalled = replanStalled(scores);
  if (score >= COVERAGE_THRESHOLD || stalled || state.planIterations >= MAX_PLAN_ITERATIONS) {
    const reason = score >= COVERAGE_THRESHOLD
      ? `coverage ${score} >= ${COVERAGE_THRESHOLD}`
      : stalled
        ? `coverage ${score} did not improve on the previous iteration (${scores[scores.length - 2]}); re-planning has converged, carrying ${gaps.length} gap(s) into the report instead of spending another plan call`
        : `coverage ${score} < ${COVERAGE_THRESHOLD} but ${state.planIterations} iterations reached`;
    deps.bus.decision({ node: "evaluate_coverage", reason, evidence: gaps, next: "generate", at: now() });
    return "generate";
  }
  deps.bus.decision({ node: "evaluate_coverage", reason: `coverage ${score} < ${COVERAGE_THRESHOLD}; re-planning`, evidence: gaps, next: "plan", at: now() });
  return "plan";
}
