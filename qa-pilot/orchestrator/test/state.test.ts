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

describe("URL expectations", () => {
  const base = { id: "auth-001", title: "Login works", category: "happy" as const, priority: "P1" as const, preconditions: [], source: "explored" as const, steps: [{ action: "goto" as const, target: "/login" }] };
  it("rejects a url_contains value that is not a URL fragment, so the planner is asked again", () => {
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "url_contains", value: "/','" }] }).success).toBe(false);
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "url_stays", value: "login page" }] }).success).toBe(false);
  });
  it("accepts ordinary paths, query strings and hash routes", () => {
    for (const value of ["/products", "/orders?page=2", "/#/faq", "products/p1"]) {
      expect(FlowSchema.safeParse({ ...base, expected: [{ type: "url_contains", value }] }).success).toBe(true);
    }
  });
});

describe("expectation specificity", () => {
  const base = { id: "coupon-001", title: "Coupon applies", category: "happy" as const, priority: "P1" as const, preconditions: [], source: "explored" as const, steps: [{ action: "goto" as const, target: "/checkout" }] };
  it("rejects a visibility expectation that names neither an element nor its text", () => {
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "visible", role: "alert" }] }).success).toBe(false);
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "text_contains" }] }).success).toBe(false);
  });
  it("accepts expectations that say what they look for", () => {
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }] }).success).toBe(true);
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "visible", role: "heading", name: "Checkout" }] }).success).toBe(true);
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "not_visible", role: "button", name: "Place order" }] }).success).toBe(true);
    expect(FlowSchema.safeParse({ ...base, expected: [{ type: "text_contains", text_contains: "Order placed" }] }).success).toBe(true);
  });
});
