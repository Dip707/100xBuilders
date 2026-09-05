import type { ChatMessage, RerunPlanData, RunRecord, RunStatus } from "./api";
import type { RunEvent } from "./events";
import { hostOf, relativeTime } from "./format";

/**
 * Statuses the copilot can act on, matching the server's own set. A run still going or parked
 * at the review gate has no results to reason about, so the run picker never offers one.
 */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "partial", "failed", "interrupted"]);

/** The runs a chat may be pointed at, in the order the API returned them - newest first. */
export function selectableRuns(runs: RunRecord[]): RunRecord[] {
  return runs.filter((r) => FINISHED.has(r.status));
}

/** How a run reads in the picker: the app it tested, then when it ran. */
export function runLabel(run: RunRecord): string {
  return `${hostOf(run.url)} · ${relativeTime(run.startedAt)}`;
}

export type LiveStatus = "queued" | "running" | "passed" | "failed";

/**
 * Where each planned test has got to, read from the run's event stream. The stream replays the
 * run's whole history on connect, so only events at or after the plan's own timestamp count;
 * an old result for the same test id would otherwise show as this rerun's outcome. A
 * classification also arrives as `test_result` but carries `test` and `class` rather than
 * `id` and `status`, and is not a status.
 */
export function liveStatuses(plan: RerunPlanData, events: RunEvent[], since: string): Record<string, LiveStatus> {
  const out: Record<string, LiveStatus> = {};
  for (const id of plan.testIds) out[id] = "queued";
  for (const e of events) {
    if (e.at < since) continue;
    const d = e.data as { id?: unknown; status?: unknown } | undefined;
    if (!d || typeof d.id !== "string" || !(d.id in out)) continue;
    if (e.type === "test_start") out[d.id] = "running";
    else if (e.type === "test_result" && typeof d.status === "string") out[d.id] = d.status === "passed" ? "passed" : "failed";
  }
  return out;
}

export function isSettled(statuses: Record<string, LiveStatus>): boolean {
  return Object.values(statuses).every((s) => s === "passed" || s === "failed");
}

/** The most recent rerun plan in a transcript that has no result after it, so a reopened chat can resume watching. */
export function pendingPlan(messages: ChatMessage[]): { plan: RerunPlanData; at: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = messages[i].data;
    if (!d) continue;
    if (d.kind === "rerun_result") return null;
    if (d.kind === "rerun_plan") return { plan: d, at: messages[i].at };
  }
  return null;
}
