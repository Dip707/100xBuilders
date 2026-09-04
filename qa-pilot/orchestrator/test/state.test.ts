import { describe, it, expect } from "vitest";
import { FlowSchema, ClassificationSchema, initialState } from "../src/state.js";

describe("state schemas", () => {
  it("accepts the PRD example flow", () => {
    const flow = FlowSchema.parse({
      id: "auth-002",
      title: "Login with wrong password shows error",
      category: "negative",
      priority: "P1",
      preconditions: ["logged_out"],
      steps: [
        { action: "goto", target: "/login" },
        { action: "fill", role: "textbox", name: "Email", value: "user@test.com" },
        { action: "fill", role: "textbox", name: "Password", value: "wrong" },
        { action: "click", role: "button", name: "Sign in" },
      ],
      expected: [
        { type: "visible", role: "alert", text_contains: "Invalid" },
        { type: "url_stays", value: "/login" },
      ],
      source: "explored",
    });
    expect(flow.steps).toHaveLength(4);
  });

  it("rejects a flow with no expectations", () => {
    expect(() =>
      FlowSchema.parse({
        id: "x", title: "x", category: "happy", priority: "P2",
        preconditions: [], steps: [{ action: "goto", target: "/" }], expected: [], source: "explored",
      }),
    ).toThrow();
  });

  it("clamps classification confidence to [0,1]", () => {
    expect(() =>
      ClassificationSchema.parse({ test: "t", class: "defect", confidence: 1.4, evidence: [], action: "escalate" }),
    ).toThrow();
  });

  it("builds an initial state with defaults", () => {
    const s = initialState({ runId: "r1", url: "http://localhost:3005" });
    expect(s.maxFlows).toBe(12);
    expect(s.budget).toEqual({ maxLlmCalls: 200, maxMinutes: 40 });
    expect(s.planIterations).toBe(0);
    expect(s.partial).toBe(false);
  });
});
