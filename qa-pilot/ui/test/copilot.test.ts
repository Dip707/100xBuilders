import { describe, it, expect } from "vitest";
import { isSettled, liveStatuses, pendingPlan } from "@/lib/copilot";
import type { RunEvent } from "@/lib/events";
import type { ChatMessage, RerunPlanData } from "@/lib/api";

const plan: RerunPlanData = { kind: "rerun_plan", runId: "r1", testIds: ["checkout-001", "checkout-002"], blocked: [] };
const ev = (type: string, id: string, at: string, status?: string): RunEvent =>
  ({ type, runId: "r1", at, data: type === "test_start" ? { id } : { id, status } });

describe("liveStatuses", () => {
  it("starts every planned test as queued", () => {
    expect(liveStatuses(plan, [], "2026-09-05T10:00:00.000Z")).toEqual({ "checkout-001": "queued", "checkout-002": "queued" });
  });

  it("moves tests through running to passed or failed from events after the plan", () => {
    const since = "2026-09-05T10:00:00.000Z";
    const events = [
      ev("test_start", "checkout-001", "2026-09-05T10:00:01.000Z"),
      ev("test_start", "checkout-002", "2026-09-05T10:00:01.000Z"),
      ev("test_result", "checkout-001", "2026-09-05T10:00:05.000Z", "failed"),
    ];
    expect(liveStatuses(plan, events, since)).toEqual({ "checkout-001": "failed", "checkout-002": "running" });
  });

  it("ignores replayed events from before the plan and events for other tests", () => {
    const since = "2026-09-05T10:00:00.000Z";
    const events = [
      ev("test_result", "checkout-001", "2026-09-05T09:00:00.000Z", "passed"),
      ev("test_result", "auth-001", "2026-09-05T10:00:03.000Z", "passed"),
    ];
    expect(liveStatuses(plan, events, since)).toEqual({ "checkout-001": "queued", "checkout-002": "queued" });
  });

  it("treats a classification event on test_result as not a status", () => {
    const events: RunEvent[] = [{ type: "test_result", runId: "r1", at: "2026-09-05T10:00:03.000Z", data: { test: "checkout-001", class: "defect", confidence: 0.9 } }];
    expect(liveStatuses(plan, events, "2026-09-05T10:00:00.000Z")["checkout-001"]).toBe("queued");
  });
});

describe("isSettled", () => {
  it("is true only when every test has a final status", () => {
    expect(isSettled({ a: "passed", b: "failed" })).toBe(true);
    expect(isSettled({ a: "passed", b: "running" })).toBe(false);
    expect(isSettled({})).toBe(true);
  });
});

describe("pendingPlan", () => {
  it("is the last rerun plan not followed by a result", () => {
    const messages: ChatMessage[] = [
      { role: "user", text: "rerun", at: "t1" },
      { role: "assistant", text: "Rerunning", at: "t2", data: plan },
    ];
    expect(pendingPlan(messages)).toEqual({ plan, at: "t2" });
    const done = messages.concat({ role: "assistant", text: "1 of 2 passed.", at: "t3", data: { kind: "rerun_result", runId: "r1", results: [] } });
    expect(pendingPlan(done)).toBeNull();
  });
});
