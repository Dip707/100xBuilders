import { z } from "zod";
import type { CoverageVerdict, Flow, FormInfo, RunState, RunUpdate, SiteMap } from "../state.js";
import { readOutput, writeOutput } from "../output.js";
import { now, type NodeDeps } from "./deps.js";

export const PrdRequirementsSchema = z.object({ requirements: z.array(z.string()) });
export const PrdMatrixSchema = z.object({ matrix: z.array(z.object({ requirement: z.string(), flow_ids: z.array(z.string()) })) });

export const COVERAGE_THRESHOLD = 0.75;
export const MAX_PLAN_ITERATIONS = 3;

type Gap = CoverageVerdict["gaps"][number];

/** Whether a flow exercises a route: it navigates there, the dry walk saw it there, or its title names it. */
const touches = (f: Flow, path: string) =>
  f.steps.some((s) => s.action === "goto" && s.target === path) ||
  (f.visits ?? []).includes(path) ||
  f.title.toLowerCase().includes(path.replace(/^\//, "").toLowerCase());

/** Words an intent is made of that never name an area of the app. */
const INTENT_FILLER = new Set(["focus", "with", "and", "the", "on", "cover", "covering", "just", "only", "not", "end", "ends", "test", "tests", "testing", "flow", "flows", "also", "then", "that", "this", "from", "into", "please", "make", "sure", "every", "each", "well", "more", "than", "rather", "especially", "particularly", "mainly", "mostly", "should", "must", "need", "needs", "check", "checks", "verify", "whole", "entire", "full", "fully", "properly", "along", "through", "beyond", "including", "include", "plus"]);
/** An empty-submit flow says so in its title, as the planner prompt requires. "Missing" and
 *  "required" are not enough: "rejects checkout when the postal code is missing" leaves one
 *  field out and is the form's negative case, not its empty case. */
/** Field types carrying a format the user can get wrong. A bare text box has no wrong answer. */
const CONSTRAINED_TYPES = new Set(["email", "password", "number", "tel", "url", "date"]);
/** A form is worth a negative case only if some field can hold something invalid. A lone
 *  optional text box - a coupon code, a search term - cannot be filled in wrongly, and
 *  demanding a negative case for it asks the planner for a test that cannot be written. */
const canBeInvalid = (form: FormInfo) => form.fields.some((f) => f.required || CONSTRAINED_TYPES.has(f.type));
/** A form is worth an empty-submit case only if it requires something. Submitting a form whose
 *  fields are all optional succeeds; there is no validation for the test to assert on. */
const canBeEmpty = (form: FormInfo) => form.fields.some((f) => f.required);
/** The same fields under the same button are the same form wherever it appears. */
const formSignature = (form: FormInfo) =>
  JSON.stringify([form.submit?.name ?? "", form.fields.map((f) => `${f.name}|${f.type}|${f.required}`).sort()]);

const isEmptySubmit = (f: Flow) => /\bempty\b|\bblank\b|no input|without (any |entering |filling )?(input|data|values|fields)|nothing (entered|filled|typed)/i.test(f.title);

export function scoreCoverage(siteMap: SiteMap, flows: Flow[], opts: { intent?: string; prdRequirements?: string[]; prdMatrix?: Record<string, string[]> }): CoverageVerdict {
  const gaps: Gap[] = [];
  const checks: Record<string, number> = {};
  const weights: Record<string, number> = {};

  // 1. forms: happy, plus a negative and an empty-submit case where the form admits one.
  // Forms are grouped by shape first: product pages p1, p2 and p3 each carry the same
  // add-to-cart form, and a flow that adds p2 exercises the same handler as one that adds
  // p1. Counting them separately tripled every gap that form had, so an app that merely
  // lists more than one product scored lower than the same app listing one.
  const groups = new Map<string, { paths: string[]; form: FormInfo }>();
  for (const page of Object.values(siteMap.pages))
    for (const form of page.forms) {
      const group = groups.get(formSignature(form));
      if (group) group.paths.push(page.path);
      else groups.set(formSignature(form), { paths: [page.path], form });
    }
  if (groups.size) {
    let pass = 0;
    for (const { paths, form } of groups.values()) {
      const on = flows.filter((f) => paths.some((path) => touches(f, path)));
      const at = paths[0];
      const cases: { ok: boolean; kind: Gap["kind"]; suggest: string }[] = [
        { ok: on.some((f) => f.category === "happy"), kind: "missing_happy", suggest: `submit ${at} form with valid data and verify success` },
      ];
      if (canBeInvalid(form)) cases.push({ ok: on.some((f) => f.category === "negative" && !isEmptySubmit(f)), kind: "missing_negative", suggest: `submit ${at} form with invalid data and verify the error` });
      if (canBeEmpty(form)) cases.push({ ok: on.some((f) => isEmptySubmit(f)), kind: "missing_empty_submit", suggest: `submit ${at} form empty and verify validation` });
      for (const c of cases) if (!c.ok) gaps.push({ kind: c.kind, target: `form:${at}`, suggest: c.suggest });
      pass += cases.filter((c) => c.ok).length / cases.length;
    }
    checks.forms = pass / groups.size;
    weights.forms = 0.2;
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
    weights.authz = 0.15;
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
    const words = [...new Set(opts.intent.toLowerCase().split(/[^a-z0-9]+/))].filter((w) => w.length > 3 && !INTENT_FILLER.has(w));
    if (words.length) {
      const hit = words.filter((w) => flows.some((f) => f.title.toLowerCase().includes(w)));
      checks.intent = hit.length / words.length;
      weights.intent = 0.1;
      for (const w of words) if (!hit.includes(w)) gaps.push({ kind: "intent_uncovered", target: w, suggest: `add a flow whose title covers "${w}"` });
    }
  }

  // 5. every route worth testing has at least one flow that visits it. Without this a
  // login-walled app scores full marks on its one login form while the whole application
  // behind the wall - catalog, cart, checkout - goes unplanned. An authz flow does not count:
  // it only proves the route is walled off, it never exercises what is on it.
  const routes = Object.values(siteMap.pages).filter((p) => p.forms.length || p.buttons.length);
  const untested = routes.filter((p) => !flows.some((f) => f.category !== "authz" && touches(f, p.path)));
  if (routes.length) {
    for (const p of untested) {
      gaps.push({ kind: "missing_route_flow", target: p.path, suggest: `no flow exercises ${p.path}; add one that uses ${p.forms.length ? "its form" : `its controls (${p.buttons.slice(0, 3).map((b) => `"${b.name}"`).join(", ")})`}` });
    }
    checks.routes = (routes.length - untested.length) / routes.length;
    weights.routes = 0.4;
  }

  // 6. category mix
  const nonHappy = flows.filter((f) => ["negative", "edge", "error_state"].includes(f.category)).length;
  const mix = flows.length ? nonHappy / flows.length : 0;
  checks.mix = Math.min(1, mix / 0.4);
  weights.mix = 0.15;
  if (mix < 0.4) gaps.push({ kind: "category_mix", suggest: `only ${(mix * 100).toFixed(0)}% of flows are negative/edge/error_state; add more` });

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const score = Object.entries(checks).reduce((acc, [k, v]) => acc + v * weights[k], 0) / totalWeight;

  const untested_risk = untested.map((p) => ({
    flow: p.path,
    reason: p.forms.length ? "form discovered but no flow exercises it" : "interactive page discovered but no flow exercises it",
    risk: "medium" as const,
  }));

  // Kept at full precision: this is the number the gate compares, and rounding 0.748 up to
  // 0.75 used to wave a half-covered plan through. The UI rounds it for display.
  return { score, gaps, untested_risk, checks, prdRequirements: opts.prdRequirements ?? [], prdMatrix: opts.prdMatrix ?? {} };
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

/**
 * Whether a re-plan could close anything. Every open gap asks for a flow the plan does not
 * have, so a plan already holding `maxFlows` flows has nowhere to put one: the planner would
 * spend another minute-long call to hand back the same number of flows with a different set
 * of gaps open. Below the cap it has room, and the gaps tell it what to fill it with.
 */
const hasRoomToReplan = (state: RunState) => state.plan.length < state.maxFlows;

export function afterCoverage(state: RunState, deps: NodeDeps): "generate" | "plan" {
  const score = state.coverage!.score;
  const gaps = state.coverage!.gaps.map((g) => `${g.kind} ${g.target ?? g.requirement ?? ""}`.trim());
  const stop =
    score >= COVERAGE_THRESHOLD ? `coverage ${score} >= ${COVERAGE_THRESHOLD}`
    : state.planIterations >= MAX_PLAN_ITERATIONS ? `coverage ${score} < ${COVERAGE_THRESHOLD} but ${state.planIterations} iterations reached`
    : !hasRoomToReplan(state) ? `coverage ${score} < ${COVERAGE_THRESHOLD} but the plan is already at its ${state.maxFlows}-flow limit, so a re-plan has no room to close a gap`
    : null;
  if (stop) {
    deps.bus.decision({ node: "evaluate_coverage", reason: stop, evidence: gaps, next: "generate", at: now() });
    return "generate";
  }
  deps.bus.decision({ node: "evaluate_coverage", reason: `coverage ${score} < ${COVERAGE_THRESHOLD}; re-planning`, evidence: gaps, next: "plan", at: now() });
  return "plan";
}
