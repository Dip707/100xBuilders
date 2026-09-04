import type { RunEvent } from "./events";

/** The pipeline nodes, in the order the strip renders them. */
export const NODES = ["explore", "plan", "evaluate_coverage", "review", "generate", "run", "classify", "heal", "report"] as const;
export type NodeName = (typeof NODES)[number];

export type NodeState = { node: NodeName; visits: number; active: boolean };
export type TestRow = { id: string; status: string; cls?: string; conf?: number };
export type DecisionRow = { node: string; reason: string; evidence: string[]; next: string };

const FEED_LIMIT = 300;

export function pipelineState(events: RunEvent[]): NodeState[] {
  const visits = new Map<string, number>();
  let active: string | null = null;
  for (const e of events) {
    if (e.type === "node_start" && e.node) {
      visits.set(e.node, (visits.get(e.node) ?? 0) + 1);
      active = e.node;
    }
    if (e.type === "done") active = null;
  }
  return NODES.map((node) => ({ node, visits: visits.get(node) ?? 0, active: active === node }));
}

/**
 * The runner emits `{ id, status }` when a test finishes and the classifier later emits
 * `{ test, class, confidence }` for the ones that failed. Both arrive as `test_result`,
 * keyed differently, and have to be merged per test id. A classification with no prior
 * status can only describe a failure, so it defaults to failed.
 */
export function testRows(events: RunEvent[]): TestRow[] {
  const rows = new Map<string, TestRow>();
  for (const e of events) {
    if (e.type !== "test_result") continue;
    const d = e.data as { id?: string; status?: string; test?: string; class?: string; confidence?: number };
    if (d.id && d.status) {
      rows.set(d.id, { ...(rows.get(d.id) ?? { id: d.id, status: d.status }), id: d.id, status: d.status });
    }
    if (d.test && d.class) {
      const existing = rows.get(d.test) ?? { id: d.test, status: "failed" };
      rows.set(d.test, { ...existing, cls: d.class, conf: d.confidence });
    }
  }
  return [...rows.values()];
}

export function tally(rows: TestRow[]): { passed: number; failed: number } {
  const passed = rows.filter((r) => r.status === "passed").length;
  return { passed, failed: rows.length - passed };
}

export function decisionRows(events: RunEvent[]): DecisionRow[] {
  return events
    .filter((e) => e.type === "decision")
    .map((e) => {
      const d = e.data as Partial<DecisionRow>;
      return { node: d.node ?? "", reason: d.reason ?? "", evidence: d.evidence ?? [], next: d.next ?? "" };
    });
}

/**
 * Screenshot events carry an absolute path on the API host. The file route is keyed by a
 * path relative to the run directory, so split on the run id. A path that does not
 * contain the run id cannot be served and yields null rather than a broken image.
 */
export function latestScreenshotPath(events: RunEvent[], runId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "screenshot") continue;
    const path = (e.data as { path?: string } | undefined)?.path;
    if (!path) continue;
    const rel = path.split(`/${runId}/`)[1];
    return rel ?? null;
  }
  return null;
}

export function isDone(events: RunEvent[]): boolean {
  return events.some((e) => e.type === "done");
}

export function feedRows(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.type === "agent_log" || e.type === "error").slice(-FEED_LIMIT);
}
