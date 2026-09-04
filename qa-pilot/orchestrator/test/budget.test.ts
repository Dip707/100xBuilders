import { describe, it, expect } from "vitest";
import { budgetExceeded } from "../src/budget.js";
import { initialState } from "../src/state.js";

describe("budgetExceeded", () => {
  it("returns null within budget", () => {
    const s = initialState({ runId: "r", url: "http://x" });
    expect(budgetExceeded(s)).toBeNull();
  });
  it("flags llm call overrun", () => {
    const s = { ...initialState({ runId: "r", url: "http://x" }), llmCalls: 201 };
    expect(budgetExceeded(s)).toMatch(/llm calls/);
  });
  it("flags time overrun", () => {
    const s = { ...initialState({ runId: "r", url: "http://x" }), startedAt: new Date(Date.now() - 41 * 60_000).toISOString() };
    expect(budgetExceeded(s)).toMatch(/minutes/);
  });
});
