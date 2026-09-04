import { describe, it, expect } from "vitest";
import { pipelineState, testRows, tally, decisionRows, latestScreenshotPath, isDone, feedRows, NODES } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

const at = "2026-09-04T12:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ type: "agent_log", runId: "run-1", at, ...e });

describe("pipelineState", () => {
  it("returns every node in pipeline order, all pending for an empty run", () => {
    const state = pipelineState([]);
    expect(state.map((n) => n.node)).toEqual([...NODES]);
    expect(state.every((n) => n.visits === 0 && !n.active)).toBe(true);
  });

  it("marks the most recently started node active and counts revisits", () => {
    const state = pipelineState([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),    ev({ type: "node_end", node: "plan" }),
      ev({ type: "node_start", node: "plan" }),
    ]);
    const byNode = Object.fromEntries(state.map((n) => [n.node, n]));
    expect(byNode.explore).toMatchObject({ visits: 1, active: false });
    expect(byNode.plan).toMatchObject({ visits: 2, active: true });
    expect(byNode.report).toMatchObject({ visits: 0, active: false });
  });

  it("clears the active node once the run is done", () => {
    const state = pipelineState([ev({ type: "node_start", node: "report" }), ev({ type: "done" })]);
    expect(state.every((n) => !n.active)).toBe(true);
  });
});

describe("testRows and tally", () => {
  it("merges a status event and a later classification for the same test", () => {
    const rows = testRows([
      ev({ type: "test_result", data: { id: "auth-001", status: "passed" } }),
      ev({ type: "test_result", data: { id: "checkout-001", status: "failed" } }),
      ev({ type: "test_result", data: { test: "checkout-001", class: "defect", confidence: 0.87 } }),
    ]);
    expect(rows).toEqual([
      { id: "auth-001", status: "passed" },
      { id: "checkout-001", status: "failed", cls: "defect", conf: 0.87 },
    ]);
    expect(tally(rows)).toEqual({ passed: 1, failed: 1 });
  });

  it("keeps the latest status when a test is rerun", () => {
    const rows = testRows([
      ev({ type: "test_result", data: { id: "flaky-001", status: "failed" } }),
      ev({ type: "test_result", data: { id: "flaky-001", status: "passed" } }),
    ]);
    expect(rows).toEqual([{ id: "flaky-001", status: "passed" }]);
    expect(tally(rows)).toEqual({ passed: 1, failed: 0 });
  });

  it("defaults a classification with no prior status to failed", () => {
    const rows = testRows([ev({ type: "test_result", data: { test: "x-1", class: "script", confidence: 0.4 } })]);
    expect(rows).toEqual([{ id: "x-1", status: "failed", cls: "script", conf: 0.4 }]);
  });

  it("ignores events that are not test results", () => {
    expect(testRows([ev({ type: "agent_log", message: "hi" })])).toEqual([]);
  });
});

describe("decisionRows", () => {
  it("returns decisions in order with their evidence", () => {
    const rows = decisionRows([
      ev({ type: "decision", data: { node: "evaluate_coverage", reason: "score 0.62 below 0.75", evidence: ["missing_negative: login"], next: "plan", at } }),
      ev({ type: "agent_log", message: "noise" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node: "evaluate_coverage", next: "plan" });
    expect(rows[0].evidence).toEqual(["missing_negative: login"]);
  });

  it("tolerates a decision with no evidence array", () => {
    const rows = decisionRows([ev({ type: "decision", data: { node: "classify", reason: "r", next: "report", at } })]);
    expect(rows[0].evidence).toEqual([]);
  });
});

describe("latestScreenshotPath", () => {
  it("returns the run-relative path of the newest screenshot", () => {
    const path = latestScreenshotPath([
      ev({ type: "screenshot", data: { path: "/out/run-1/screenshots/a.png" } }),
      ev({ type: "screenshot", data: { path: "/out/run-1/screenshots/b.png" } }),
    ], "run-1");
    expect(path).toBe("screenshots/b.png");
  });

  it("returns null with no screenshots, and for a path that does not contain the run id", () => {
    expect(latestScreenshotPath([], "run-1")).toBeNull();
    expect(latestScreenshotPath([ev({ type: "screenshot", data: { path: "/elsewhere/a.png" } })], "run-1")).toBeNull();
  });
});

describe("isDone and feedRows", () => {
  it("detects the done event", () => {
    expect(isDone([])).toBe(false);
    expect(isDone([ev({ type: "done" })])).toBe(true);
  });

  it("keeps only log and error lines, newest last, capped at 300", () => {
    const many = Array.from({ length: 400 }, (_, i) => ev({ type: "agent_log", message: `m${i}` }));
    const rows = feedRows([...many, ev({ type: "error", message: "boom" }), ev({ type: "screenshot" })]);
    expect(rows).toHaveLength(300);
    expect(rows.at(-1)!.message).toBe("boom");
  });
});
