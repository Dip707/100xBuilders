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

/** The sentence the chat shows when a rerun finishes. */
export function summariseRerun(results: TestResult[], requested: string[]): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  const passed = requested.filter((id) => byId.get(id)?.status === "passed").length;
  const parts = [`${passed} of ${requested.length} passed.`];
  for (const id of requested) {
    const r = byId.get(id);
    if (!r) parts.push(`${id} produced no result; the runner may have failed to start.`);
    else if (r.status !== "passed") parts.push(`${id} still fails${r.error ? `: ${firstLine(r.error)}` : ` (${r.status})`}`);
  }
  return parts.join(" ");
}

/** What is stored on the message: enough to draw the table, never the network log or paths. */
export function resultData(runId: string, results: TestResult[]): RerunResultData {
  return {
    kind: "rerun_result",
    runId,
    results: results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      ...(r.error ? { error: r.error.slice(0, RESULT_ERROR_HEAD) } : {}),
      durationMs: r.durationMs,
    })),
  };
}
