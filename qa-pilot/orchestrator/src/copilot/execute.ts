import type { TestResult } from "../state.js";
import type { RerunResultData } from "../store/types.js";
import type { Catalogue } from "./catalogue.js";

/** Characters of an error kept on the stored result. The chat shows the assertion, not the stack. */
const RESULT_ERROR_HEAD = 300;

export type RerunPlan = {
  runnable: string[];
  blocked: { id: string; reason: string }[];
  /** True when a runnable test signs in and the only way to sign in is credentials typed into the chat. */
  needsCredentials: boolean;
};

const NO_LOGIN = "signs in, and this run's login can no longer be replayed; start a new run to test it again";

/**
 * Splits a selection into what can run and what cannot. A test that signs in can run when the
 * run's login steps are still in memory, or when the redacted login file exists and the
 * execute request will bring credentials; otherwise it is blocked with the reason the chat shows.
 */
export function planRerun(testIds: string[], catalogue: Catalogue, opts: { hasContext: boolean; hasLoginFile: boolean }): RerunPlan {
  const byId = new Map(catalogue.tests.map((t) => [t.id, t]));
  const plan: RerunPlan = { runnable: [], blocked: [], needsCredentials: false };
  for (const id of testIds) {
    const t = byId.get(id);
    if (!t || !t.generated) {
      plan.blocked.push({ id, reason: "test not found" });
      continue;
    }
    if (t.signsIn && !opts.hasContext) {
      if (!opts.hasLoginFile) {
        plan.blocked.push({ id, reason: NO_LOGIN });
        continue;
      }
      plan.needsCredentials = true;
    }
    plan.runnable.push(id);
  }
  return plan;
}

const firstLine = (s: string) => s.split("\n")[0].trim();

/** The classifier's classes in the words the chat uses for them. */
export const VERDICT_WORDS: Record<string, string> = {
  defect: "an app defect",
  env: "an environment error",
  script: "a script bug",
  flaky: "a flaky test",
  needs_human: "a failure that needs a human",
};

/**
 * The sentence the chat shows when a rerun finishes. A rerun does not classify, so the
 * verdict named here is the pipeline run's own, read from the catalogue: the chat repeats
 * the product's judgement rather than making a fresh one from the error text.
 */
export function summariseRerun(results: TestResult[], requested: string[], catalogue?: Catalogue): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  const verdicts = new Map((catalogue?.tests ?? []).map((t) => [t.id, t.verdict?.class]));
  const passed = requested.filter((id) => byId.get(id)?.status === "passed").length;
  const parts = [`${passed} of ${requested.length} passed.`];
  for (const id of requested) {
    const r = byId.get(id);
    if (!r) {
      parts.push(`${id} produced no result; the runner may have failed to start.`);
      continue;
    }
    if (r.status === "passed") continue;
    const verdict = verdicts.get(id);
    const words = verdict ? VERDICT_WORDS[verdict] : undefined;
    const clause = !words ? "" : verdict === "defect" ? ` and the classifier calls it ${words}` : ` and the classifier called it ${words}`;
    parts.push(`${id} still fails${clause}${r.error ? `: ${firstLine(r.error)}` : ` (${r.status})`}`);
  }
  return parts.join(" ");
}

/**
 * What is stored on the message: enough to draw the table, never the network log or paths.
 * Each row carries the original run's verdict and defect id, so a reopened chat can offer
 * a ticket from the stored message alone.
 */
export function resultData(runId: string, results: TestResult[], catalogue?: Catalogue): RerunResultData {
  const entries = new Map((catalogue?.tests ?? []).map((t) => [t.id, t]));
  return {
    kind: "rerun_result",
    runId,
    results: results.map((r) => {
      const entry = entries.get(r.id);
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        ...(r.error ? { error: r.error.slice(0, RESULT_ERROR_HEAD) } : {}),
        durationMs: r.durationMs,
        ...(entry?.verdict ? { verdict: { class: entry.verdict.class, confidence: entry.verdict.confidence } } : {}),
        ...(entry?.defectId ? { defectId: entry.defectId } : {}),
      };
    }),
  };
}
