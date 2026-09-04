import { z } from "zod";
import type { CoverageVerdict, Flow, RunState, RunUpdate, SiteMap } from "../state.js";
import { readOutput, writeOutput } from "../output.js";
import { now, type NodeDeps } from "./deps.js";

export const PrdRequirementsSchema = z.object({ requirements: z.array(z.string()) });
export const PrdMatrixSchema = z.object({ matrix: z.array(z.object({ requirement: z.string(), flow_ids: z.array(z.string()) })) });

export const COVERAGE_THRESHOLD = 0.75;
export const MAX_PLAN_ITERATIONS = 3;

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
      const hit = words.filter((w) => flows.some((f) => f.title.toLowerCase().includes(w)));
      checks.intent = hit.length / words.length;
      weights.intent = 0.1;
      for (const w of words) if (!hit.includes(w)) gaps.push({ kind: "intent_uncovered", target: w, suggest: `add a flow whose title covers "${w}"` });
    }
  }

  // 5. category mix
  const nonHappy = flows.filter((f) => ["negative", "edge", "error_state"].includes(f.category)).length;
  const mix = flows.length ? nonHappy / flows.length : 0;
  checks.mix = Math.min(1, mix / 0.4);
  weights.mix = 0.2;
  if (mix < 0.4) gaps.push({ kind: "category_mix", suggest: `only ${(mix * 100).toFixed(0)}% of flows are negative/edge/error_state; add more` });

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
    if (prdRequirements.length === 0) {
      const r = await deps.llm.complete({ prompt: "prd-requirements", input: state.prdText, schema: PrdRequirementsSchema, effort: "medium" });
      llmCalls++;
      prdRequirements = r.requirements;
    }
    if (prdRequirements.length) {
      const m = await deps.llm.complete({
        prompt: "prd-matrix",
        input: `REQUIREMENTS:\n${prdRequirements.map((r) => `- ${r}`).join("\n")}\n\nFLOWS:\n${state.plan.map((f) => `- ${f.id}: ${f.title} | steps: ${f.steps.map((s) => `${s.action} ${s.name ?? s.target ?? ""}`).join(", ")}`).join("\n")}`,
        schema: PrdMatrixSchema,
        effort: "medium",
      });
      llmCalls++;
      for (const row of m.matrix) prdMatrix[row.requirement] = row.flow_ids;
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
  if (score >= COVERAGE_THRESHOLD || state.planIterations >= MAX_PLAN_ITERATIONS) {
    deps.bus.decision({ node: "evaluate_coverage", reason: score >= COVERAGE_THRESHOLD ? `coverage ${score} >= ${COVERAGE_THRESHOLD}` : `coverage ${score} < ${COVERAGE_THRESHOLD} but ${state.planIterations} iterations reached`, evidence: gaps, next: "generate", at: now() });
    return "generate";
  }
  deps.bus.decision({ node: "evaluate_coverage", reason: `coverage ${score} < ${COVERAGE_THRESHOLD}; re-planning`, evidence: gaps, next: "plan", at: now() });
  return "plan";
}
