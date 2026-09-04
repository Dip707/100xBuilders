import { describe, it, expect } from "vitest";
import {
  areaOf, caseRows, statusCounts, groupByUseCase, filterRows, runProgress, isAwaitingReview, activeNode,
  artifactRel, latestScreenshotBy, stepLabel, expectationLabel, describeFlow, stepStates, type Flow,
} from "@/lib/cases";
import type { RunEvent } from "@/lib/events";

const at = "2026-09-04T12:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ type: "agent_log", runId: "run-1", at, ...e });

const flow = (id: string, extra: Partial<Flow> = {}): Flow => ({
  id, title: `Flow ${id}`, category: "happy", priority: "P1", preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: "/login" }, { action: "fill", role: "textbox", name: "Email", value: "a@b.c" }, { action: "click", role: "button", name: "Sign in" }],
  expected: [{ type: "url_contains", value: "/products" }],
  ...extra,
});
const plan = [flow("auth-001"), flow("auth-002"), flow("checkout-001"), flow("zzz-001")];

describe("areaOf", () => {
  it("names known prefixes and capitalises unknown ones", () => {
    expect(areaOf("auth-001")).toBe("Authentication");
    expect(areaOf("authz-002")).toBe("Access control");
    expect(areaOf("checkout-001")).toBe("Checkout");
    expect(areaOf("zzz-001")).toBe("Zzz");
    expect(areaOf("")).toBe("Other");
  });
});

describe("caseRows", () => {
  it("starts every planned flow as planned", () => {
    const rows = caseRows([], plan);
    expect(rows.map((r) => r.status)).toEqual(["planned", "planned", "planned", "planned"]);
    expect(rows[0].useCase).toBe("Authentication");
  });

  it("moves through running to a result, and a rerun supersedes an earlier result", () => {
    const rows = caseRows([
      ev({ type: "test_start", at: "2026-09-04T12:00:01.000Z", data: { id: "auth-001" } }),
      ev({ type: "test_result", at: "2026-09-04T12:00:02.000Z", data: { id: "auth-001", status: "failed", failingStep: 1 } }),
      ev({ type: "test_result", data: { test: "auth-001", class: "script", confidence: 0.7 } }),
      ev({ type: "test_start", at: "2026-09-04T12:00:03.000Z", data: { id: "auth-001" } }),
      ev({ type: "test_result", at: "2026-09-04T12:00:04.000Z", data: { id: "auth-001", status: "passed" } }),
    ], plan);
    const row = rows.find((r) => r.id === "auth-001")!;
    expect(row.status).toBe("passed");
    expect(row.at).toBe("2026-09-04T12:00:04.000Z");
    expect(row.classification).toBeUndefined();
  });

  it("keeps the classification of the latest failure", () => {
    const rows = caseRows([
      ev({ type: "test_result", data: { id: "auth-002", status: "failed" } }),
      ev({ type: "test_result", data: { test: "auth-002", class: "defect", confidence: 0.9 } }),
    ], plan);
    expect(rows.find((r) => r.id === "auth-002")).toMatchObject({ status: "failed", classification: { class: "defect", confidence: 0.9 } });
  });

  it("blocks unresolved, env, needs_human and skipped tests with a reason", () => {
    const rows = caseRows([
      ev({ type: "node_end", node: "generate", message: "auth-001", data: { status: "unresolved" } }),
      ev({ type: "test_result", data: { id: "auth-002", status: "failed" } }),
      ev({ type: "test_result", data: { test: "auth-002", class: "needs_human", confidence: 0.4 } }),
      ev({ type: "test_result", data: { id: "checkout-001", status: "skipped" } }),
    ], plan);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["auth-001"]).toMatchObject({ status: "blocked", blockedReason: "could not be resolved on the live page" });
    expect(byId["auth-002"]).toMatchObject({ status: "blocked", blockedReason: "needs a human" });
    expect(byId["checkout-001"]).toMatchObject({ status: "blocked", blockedReason: "skipped" });
    expect(byId["zzz-001"].status).toBe("planned");
  });

  it("ignores results for tests that are not in the plan", () => {
    expect(caseRows([ev({ type: "test_result", data: { id: "ghost-1", status: "passed" } })], plan)).toHaveLength(4);
  });
});

describe("counts, groups, filters and progress", () => {
  const rows = caseRows([
    ev({ type: "test_result", data: { id: "auth-001", status: "passed" } }),
    ev({ type: "test_result", data: { id: "auth-002", status: "failed" } }),
    ev({ type: "test_start", data: { id: "checkout-001" } }),
  ], plan);

  it("counts every status plus the total", () => {
    expect(statusCounts(rows)).toEqual({ all: 4, planned: 1, running: 1, passed: 1, failed: 1, blocked: 0 });
  });

  it("groups by use case in plan order", () => {
    expect(groupByUseCase(rows).map((g) => [g.useCase, g.rows.length])).toEqual([["Authentication", 2], ["Checkout", 1], ["Zzz", 1]]);
  });

  it("filters by status and by a query over id, title and use case", () => {
    expect(filterRows(rows, { status: "failed" }).map((r) => r.id)).toEqual(["auth-002"]);
    expect(filterRows(rows, { query: "CHECK" }).map((r) => r.id)).toEqual(["checkout-001"]);
    expect(filterRows(rows, { query: "authentication", status: "all" })).toHaveLength(2);
  });

  it("reports progress and a pass rate over finished tests only", () => {
    expect(runProgress(rows)).toEqual({ total: 4, done: 2, running: 1, passed: 1, failed: 1, blocked: 0, planned: 1, passRate: 0.5 });
    expect(runProgress(caseRows([], plan)).passRate).toBeNull();
  });
});

describe("run state helpers", () => {
  it("detects the review gate", () => {
    expect(isAwaitingReview([ev({ type: "node_start", node: "review" })])).toBe(true);
    expect(isAwaitingReview([ev({ type: "node_start", node: "review" }), ev({ type: "node_end", node: "review" })])).toBe(false);
    expect(isAwaitingReview([])).toBe(false);
  });

  it("tracks the active node", () => {
    expect(activeNode([ev({ type: "node_start", node: "run" })])).toBe("run");
    expect(activeNode([ev({ type: "node_start", node: "run" }), ev({ type: "node_end", node: "run" })])).toBeNull();
    expect(activeNode([ev({ type: "node_start", node: "report" }), ev({ type: "done" })])).toBeNull();
  });

  it("relativises artifact paths and finds an agent's latest screenshot", () => {
    expect(artifactRel("/srv/output/run-1/traces/videos/a.webm", "run-1")).toBe("traces/videos/a.webm");
    expect(artifactRel("/elsewhere/a.webm", "run-1")).toBeNull();
    expect(artifactRel(undefined, "run-1")).toBeNull();
    const events = [
      ev({ type: "screenshot", agent: "generator:auth-001", data: { path: "/o/run-1/traces/generate/1.png" } }),
      ev({ type: "screenshot", agent: "generator:auth-002", data: { path: "/o/run-1/traces/generate/2.png" } }),
    ];
    expect(latestScreenshotBy(events, "run-1", "generator:auth-001")).toBe("traces/generate/1.png");
    expect(latestScreenshotBy(events, "run-1", "healer")).toBeNull();
  });
});

describe("narration", () => {
  it("narrates steps and expectations", () => {
    expect(stepLabel({ action: "goto", target: "/login" })).toBe("Navigate to /login");
    expect(stepLabel({ action: "fill", role: "textbox", name: "Email", value: "a@b.c" })).toBe("Fill 'a@b.c' into Email textbox");
    expect(stepLabel({ action: "click", role: "button", name: "Sign in" })).toBe("Click Sign in button");
    expect(expectationLabel({ type: "visible", role: "alert", text_contains: "Invalid" })).toBe("Verify alert shows 'Invalid'");
    expect(expectationLabel({ type: "url_contains", value: "/products" })).toBe("Verify the URL contains '/products'");
  });

  it("describes a flow from its precondition and expectations", () => {
    expect(describeFlow(flow("auth-001", { title: "Sign in with valid credentials", preconditions: ["logged_out"] })))
      .toBe("As a visitor: Sign in with valid credentials. Verify the URL contains '/products'.");
  });

  it("derives per-step states from the failing step", () => {
    const f = flow("auth-001");
    expect(stepStates(f, { status: "passed" })).toEqual({ steps: ["passed", "passed", "passed"], expectations: ["passed"] });
    expect(stepStates(f, { status: "failed", result: { id: "auth-001", status: "failed", failingStep: 1 } })).toEqual({ steps: ["passed", "failed", "skipped"], expectations: ["skipped"] });
    expect(stepStates(f, { status: "failed", result: { id: "auth-001", status: "failed" } })).toEqual({ steps: ["passed", "passed", "passed"], expectations: ["failed"] });
    expect(stepStates(f, { status: "running" }).steps).toEqual(["pending", "pending", "pending"]);
  });
});
