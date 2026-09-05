import { z } from "zod";
import { BrowserToolkit } from "../browser/toolkit.js";
import { findNearTwins, parseSnapshot } from "../browser/snapshot.js";
import { outputDir, type Classification, type Defect, type Flow, type RunState, type RunUpdate, type TestResult } from "../state.js";
import { makeDefect } from "./defects.js";
import { now, type NodeDeps } from "./deps.js";

export const RationaleSchema = z.object({ rationale: z.string(), confidence_adjustment: z.number().min(-0.1).max(0.1) });
export const MAX_HEAL_ATTEMPTS = 2;
export const MAX_RERUNS = 2;

export type Evidence = {
  test: TestResult;
  flow: Flow;
  snapshotAtFailure: string;
  controlPassed: boolean | null;
  sameLocatorFailures: number;
  previousStatus?: TestResult["status"];
};
type Class = "script" | "defect" | "flaky" | "env";

const isLocatorError = (err: string) => /waiting for|locator|not found|strict mode violation|resolved to \d+ elements/i.test(err);
const isAssertionError = (err: string) => /expect\(|toContainText|toBeVisible|toHaveURL|toHaveValue/i.test(err);
const isEnvError = (err: string) => /net::ERR|ECONNREFUSED|page\.goto.*Timeout|Navigation timeout|Target closed|browser has been closed/i.test(err);
const isStrictModeError = (err: string) => /strict mode violation/i.test(err);
/** An assertion whose target element could not be found at all (as opposed to one that was found with the wrong content). */
const isMissingTargetAssertion = (err: string) => /element\(s\) not found|not found|waiting for/i.test(err);

/** The `getByRole('role', { name: 'Name' })` locator a Playwright error message reports, if any. */
export function locatorInError(err: string): { role: string; name: string } | undefined {
  const m = /getByRole\('([a-z]+)',\s*\{\s*name:\s*'((?:[^'\\]|\\.)*)'/.exec(err);
  return m ? { role: m[1], name: m[2].replace(/\\'/g, "'") } : undefined;
}

/** `new URL(url).pathname`, falling back to the raw string for relative or malformed URLs. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function scoreSignals(e: Evidence): { weights: Record<Class, number>; evidence: string[] } {
  const w: Record<Class, number> = { script: 0, defect: 0, flaky: 0, env: 0 };
  const ev: string[] = [];
  const err = e.test.error ?? "";
  const step = e.test.failingStep !== undefined ? e.flow.steps[e.test.failingStep] : undefined;

  if (e.previousStatus === "failed" && e.test.status === "passed") {
    w.flaky += 0.6;
    ev.push("passed on rerun");
  } else if (e.previousStatus === "failed") {
    w.defect += 0.2;
    ev.push("still failing after rerun");
  }
  if (isEnvError(err) || (e.test.failingStep === 0 && step?.action === "goto" && e.test.status === "timedOut")) {
    w.env += 0.6;
    ev.push(`environment error: ${err.split("\n")[0]}`);
  }
  const assertion = isAssertionError(err);
  const strict = isStrictModeError(err);
  const errLocator = locatorInError(err);
  // A locator matching more than one element is a defect in the generated locator, never in the app.
  if (strict) {
    w.script += 0.8;
    ev.push(`strict mode violation: ${errLocator ? `${errLocator.role} "${errLocator.name}"` : "the locator"} matches more than one element; it needs exact: true`);
  }
  /** Weighs whether the missing element was renamed (a twin of the same role exists) or removed. */
  const twinSignal = (ref: { role: string; name: string }, what: string) => {
    const twins = findNearTwins(parseSnapshot(e.snapshotAtFailure), ref);
    if (twins.length && (twins[0].similarity >= 0.3 || twins.length <= 3)) {
      w.script += 0.4;
      ev.push(`${what} "${ref.name}" not found but near-twin ${ref.role} "${twins[0].node.name}" exists (similarity ${twins[0].similarity.toFixed(2)}, ${twins.length} ${ref.role}s on page)`);
    } else if (twins.length) {
      w.script += 0.2;
      ev.push(`${what} "${ref.name}" not found; other ${ref.role} elements present: ${twins.slice(0, 3).map((t) => `"${t.node.name}"`).join(", ")}`);
    } else {
      w.defect += 0.3;
      ev.push(`${what} "${ref.name}" not found and no ${ref.role} alternative in snapshot`);
    }
  };
  // Assertion messages also mention "locator", so a step-level locator failure is only read from non-assertion errors.
  const missingAssertionTarget = assertion && !strict && errLocator !== undefined && isMissingTargetAssertion(err);
  if (!strict && !assertion && isLocatorError(err) && step?.role && step.name) twinSignal({ role: step.role, name: step.name }, "locator");
  else if (missingAssertionTarget) twinSignal(errLocator!, "assertion target");
  const bad = e.test.network.filter((n) => n.status >= 400);
  if (bad.length) {
    w.defect += bad.some((n) => n.status >= 500) ? 0.6 : 0.3;
    ev.push(...bad.slice(0, 3).map((n) => `${n.method} ${pathOf(n.url)} returned ${n.status}`));
  }
  if (e.test.pageErrors.length) {
    w.defect += 0.3;
    ev.push(`page error: ${e.test.pageErrors[0].slice(0, 120)}`);
  }
  // A locator-level assertion failure already has its explanation above.
  if (assertion && !strict && !missingAssertionTarget) {
    const m = /Expected[^\n]*:\s*(.+)\n[^\n]*Received[^\n]*:\s*(.+)/i.exec(err);
    if (m && sharesWords(m[1], m[2])) {
      w.script += 0.3;
      ev.push(`assertion text "${m[2].trim()}" is a paraphrase of expected "${m[1].trim()}"`);
    } else if (!bad.length) {
      w.defect += 0.2;
      ev.push("assertion failed with no script-side explanation");
    }
  }
  if (e.controlPassed === true) {
    w.script += 0.2;
    ev.push("happy-path control test for the same flow passes");
  } else if (e.controlPassed === false) {
    w.defect += 0.3;
    ev.push("happy-path control test for the same flow also fails");
  }
  if (e.sameLocatorFailures >= 2) {
    w.script += 0.3;
    ev.push(`${e.sameLocatorFailures} tests fail on the same locator`);
  }
  return { weights: w, evidence: ev };
}

function sharesWords(a: string, b: string): boolean {
  const ta = new Set(a.toLowerCase().match(/[a-z]+/g) ?? []);
  const tb = new Set(b.toLowerCase().match(/[a-z]+/g) ?? []);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter > 0 && inter / Math.max(ta.size, tb.size) >= 0.4;
}

/** The reviewer may nudge a mid-band (0.5 to 0.8) confidence by up to 0.1; confident and weak verdicts stand as the rules scored them. */
export function adjustConfidence(confidence: number, adjustment: number): number {
  const adjusted = confidence >= 0.5 && confidence < 0.8 ? confidence + adjustment : confidence;
  return Math.round(Math.max(0, Math.min(1, adjusted)) * 100) / 100;
}

export function classifyOne(e: Evidence, healAttempts: number, rerunAttempts: number): Classification {
  const { weights, evidence } = scoreSignals(e);
  const [cls, raw] = (Object.entries(weights) as [Class, number][]).sort((a, b) => b[1] - a[1])[0];
  const confidence = Math.min(1, Math.round(raw * 100) / 100);
  if (confidence < 0.5) return { test: e.test.id, class: "needs_human", confidence, evidence: [...evidence, "confidence below 0.5"], action: "needs_human" };
  if (confidence < 0.8 && rerunAttempts < MAX_RERUNS && e.test.status !== "passed") return { test: e.test.id, class: cls, confidence, evidence: [...evidence, "confidence in 0.5-0.8 band: rerun and control test first"], action: "rerun" };
  switch (cls) {
    case "script": return { test: e.test.id, class: cls, confidence, evidence, action: healAttempts < MAX_HEAL_ATTEMPTS ? "heal" : "escalate" };
    case "defect": return { test: e.test.id, class: cls, confidence, evidence, action: "escalate" };
    case "flaky": return { test: e.test.id, class: cls, confidence, evidence, action: rerunAttempts < MAX_RERUNS ? "rerun" : "escalate" };
    case "env": return { test: e.test.id, class: cls, confidence, evidence, action: "stop" };
  }
}

async function gatherEvidence(state: RunState, deps: NodeDeps, failed: TestResult[]): Promise<Evidence[]> {
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent: "classifier", screenshotDir: outputDir(state.runId) + "traces/classify" });
  const out: Evidence[] = [];
  const previous = new Map((state.classifications ?? []).map((c) => [c.test, c]));
  try {
    for (const test of failed) {
      const flow = state.plan.find((f) => f.id === test.id)!;
      let snapshot = "";
      // A failure on an expect line happened after every step ran, so the whole flow is replayed.
      const replayTo = test.failingStep ?? (test.failingExpect !== undefined ? flow.steps.length : undefined);
      if (replayTo !== undefined) {
        // Every flow starts from a clean session: one flow's login must never carry into the
        // next flow's replay, which may have `logged_out` as its own precondition.
        await kit.clearCookies();
        const page = await kit.newPage();
        try {
          if (flow.preconditions.includes("logged_in")) for (const s of state.siteMap?.loginSteps ?? []) await kit.act(page, s);
          for (let i = 0; i < replayTo; i++) await kit.act(page, flow.steps[i]);
          snapshot = await kit.snapshot(page);
          await kit.screenshot(page, `failure ${test.id}`);
        } finally {
          await page.close();
        }
      }
      const control = state.results!.tests.find((t) => t.id !== test.id && state.plan.find((f) => f.id === t.id)?.category === "happy" && sameArea(flow, state.plan.find((f) => f.id === t.id)!));
      const failingName = test.failingStep !== undefined ? flow.steps[test.failingStep]?.name : undefined;
      const sameLocatorFailures = failingName ? failed.filter((t) => t.id !== test.id && t.failingStep !== undefined && state.plan.find((f) => f.id === t.id)?.steps[t.failingStep!]?.name === failingName).length + 1 : 0;
      out.push({ test, flow, snapshotAtFailure: snapshot, controlPassed: control ? control.status === "passed" : null, sameLocatorFailures, previousStatus: previous.get(test.id) ? "failed" : undefined });
    }
  } finally {
    await kit.close();
  }
  return out;
}

function sameArea(a: Flow, b: Flow): boolean {
  const path = (f: Flow) => f.steps.find((s) => s.action === "goto")?.target ?? "";
  return path(a) === path(b) || a.id.split("-")[0] === b.id.split("-")[0];
}

export async function classifyNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "classify" });
  let llmCalls = state.llmCalls;
  const tests = state.results!.tests;
  const previous = new Map(state.classifications.map((c) => [c.test, c]));
  const previouslyFailed = new Set(state.classifications.filter((c) => c.action !== "healed").map((c) => c.test));
  const failed = tests.filter((t) => t.status !== "passed" && t.status !== "skipped");
  const recovered = tests.filter((t) => t.status === "passed" && previouslyFailed.has(t.id));
  const evidence = await gatherEvidence(state, deps, failed);
  for (const t of recovered) evidence.push({ test: t, flow: state.plan.find((f) => f.id === t.id)!, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0, previousStatus: "failed" });

  const classifications: Classification[] = [];
  const ticketed = new Set(state.defects.map((d) => d.flow));
  for (const e of evidence) {
    // A test that already has a ticket stays escalated: re-analysing it would only heal it
    // again or file the same defect twice.
    if (e.test.status !== "passed" && ticketed.has(e.test.id)) {
      const ticket = state.defects.find((d) => d.flow === e.test.id)!;
      classifications.push({ test: e.test.id, class: "defect", confidence: previous.get(e.test.id)?.confidence ?? 1, evidence: [`already escalated as ${ticket.id}`], action: "escalate" });
      continue;
    }
    const c = classifyOne(e, state.healAttempts[e.test.id] ?? 0, state.rerunAttempts[e.test.id] ?? 0);
    if (e.test.status === "passed") {
      const heal = state.healLog.find((h) => h.test === e.test.id && h.accepted);
      classifications.push(
        heal
          ? { ...c, class: "script", confidence: heal.confidence, action: "healed", evidence: [`healed: ${heal.before} -> ${heal.after}`, "passed after heal"] }
          : { ...c, class: "flaky", action: "escalate", evidence: ["failed previously, passed on rerun"] },
      );
      continue;
    }
    try {
      const r = await deps.llm.complete({
        prompt: "classify-rationale",
        input: `TEST: ${e.test.id} (${e.flow.title})\nCLASS: ${c.class}\nCONFIDENCE: ${c.confidence}\nERROR:\n${e.test.error}\nEVIDENCE:\n${c.evidence.map((x) => `- ${x}`).join("\n")}\nCONSOLE ERRORS: ${e.test.consoleErrors.slice(0, 3).join(" | ") || "none"}`,
        schema: RationaleSchema,
        effort: "low",
      });
      llmCalls++;
      classifications.push({ ...c, confidence: adjustConfidence(c.confidence, r.confidence_adjustment), rationale: r.rationale });
    } catch (err) {
      deps.bus.emit({ type: "error", node: "classify", message: (err as Error).message });
      classifications.push(c);
    }
    deps.bus.emit({ type: "test_result", message: `${e.test.id} classified ${c.class} ${c.confidence}`, data: classifications[classifications.length - 1] });
  }
  const defects: Defect[] = classifications
    .filter((c) => c.class === "defect" && c.action === "escalate" && !ticketed.has(c.test))
    .map((c) => makeDefect(state, c.test, tests.find((t) => t.id === c.test)?.error ?? "see evidence", c.evidence));
  for (const d of defects) deps.bus.decision({ node: "classify", reason: `escalating ${d.flow} as ${d.severity} defect`, evidence: d.evidence, next: "ticket", at: now() });
  deps.bus.emit({ type: "node_end", node: "classify", data: { failed: failed.length, defects: defects.length } });
  return { classifications, defects, llmCalls };
}

export function afterClassify(state: RunState, deps: NodeDeps): "heal" | "rerun" | "report" {
  const cs = state.classifications;
  const toHeal = cs.filter((c) => c.action === "heal");
  const toRerun = cs.filter((c) => c.action === "rerun");
  if (cs.some((c) => c.class === "env" && c.action === "stop")) {
    deps.bus.decision({ node: "classify", reason: "environment failure detected; stopping to avoid false defects", evidence: cs.filter((c) => c.class === "env").flatMap((c) => c.evidence), next: "report", at: now() });
    return "report";
  }
  if (toHeal.length) {
    deps.bus.decision({ node: "classify", reason: `${toHeal.length} script failure(s) with heal attempts remaining`, evidence: toHeal.map((c) => `${c.test}: ${c.class} ${c.confidence}`), next: "heal", at: now() });
    return "heal";
  }
  if (toRerun.length) {
    deps.bus.decision({ node: "classify", reason: `${toRerun.length} test(s) need a rerun to confirm`, evidence: toRerun.map((c) => `${c.test}: ${c.class} ${c.confidence}`), next: "run", at: now() });
    return "rerun";
  }
  deps.bus.decision({ node: "classify", reason: cs.length ? "all failures classified; nothing left to heal or rerun" : "all tests passed", evidence: cs.map((c) => `${c.test}: ${c.class} ${c.confidence} -> ${c.action}`), next: "report", at: now() });
  return "report";
}
