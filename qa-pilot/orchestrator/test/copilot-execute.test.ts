import { describe, it, expect } from "vitest";
import { planRerun, resultData, summariseRerun } from "../src/copilot/execute.js";
import type { Catalogue } from "../src/copilot/catalogue.js";
import type { TestResult } from "../src/state.js";

const catalogue: Catalogue = {
  runId: "c1", url: "http://localhost:3005", status: "done",
  tests: [
    { id: "auth-001", title: "Login", category: "happy", priority: "P0", preconditions: [], status: "failed", generated: true, signsIn: false },
    { id: "checkout-001", title: "Coupon", category: "happy", priority: "P1", preconditions: [], status: "failed", generated: true, signsIn: true },
  ],
};

/** The same catalogue after the pipeline classified both failures. */
const withVerdicts: Catalogue = {
  ...catalogue,
  tests: [
    { ...catalogue.tests[0], verdict: { class: "env", confidence: 0.6, action: "rerun" } },
    { ...catalogue.tests[1], verdict: { class: "defect", confidence: 0.9, action: "escalate", rationale: "500 from the coupon endpoint" }, defectId: "DEF-1-checkout-001" },
  ],
};

const result = (id: string, status: TestResult["status"], error?: string): TestResult => ({
  id, file: "f", title: id, status, network: [], consoleErrors: [], pageErrors: [], durationMs: 1200, ...(error ? { error } : {}),
});

describe("planRerun", () => {
  it("runs everything when the run's login is still in memory", () => {
    expect(planRerun(["auth-001", "checkout-001"], catalogue, { hasContext: true, hasLoginFile: false }))
      .toEqual({ runnable: ["auth-001", "checkout-001"], blocked: [], needsCredentials: false });
  });

  it("asks for credentials when a signed-in test can be rehydrated from the login file", () => {
    const p = planRerun(["auth-001", "checkout-001"], catalogue, { hasContext: false, hasLoginFile: true });
    expect(p.runnable).toEqual(["auth-001", "checkout-001"]);
    expect(p.needsCredentials).toBe(true);
  });

  it("blocks a signed-in test when neither the context nor the login file exists", () => {
    const p = planRerun(["auth-001", "checkout-001"], catalogue, { hasContext: false, hasLoginFile: false });
    expect(p.runnable).toEqual(["auth-001"]);
    expect(p.blocked).toEqual([{ id: "checkout-001", reason: "signs in, and this run's login can no longer be replayed; start a new run to test it again" }]);
    expect(p.needsCredentials).toBe(false);
  });

  it("blocks ids that are not in the catalogue", () => {
    const p = planRerun(["ghost-1"], catalogue, { hasContext: true, hasLoginFile: true });
    expect(p.runnable).toEqual([]);
    expect(p.blocked).toEqual([{ id: "ghost-1", reason: "test not found" }]);
  });
});

describe("summariseRerun", () => {
  it("counts passes and names each failure with its error head", () => {
    const text = summariseRerun([result("auth-001", "passed"), result("checkout-001", "failed", "Error: expect(locator).toContainText(expected) failed\nLocator: x")], ["auth-001", "checkout-001"]);
    expect(text).toBe("1 of 2 passed. checkout-001 still fails: Error: expect(locator).toContainText(expected) failed");
  });

  it("reports a clean sweep", () => {
    expect(summariseRerun([result("auth-001", "passed")], ["auth-001"])).toBe("1 of 1 passed.");
  });

  it("names tests that produced no result at all", () => {
    expect(summariseRerun([], ["auth-001"])).toBe("0 of 1 passed. auth-001 produced no result; the runner may have failed to start.");
  });

  it("says when the classifier called a still-failing test an app defect", () => {
    const text = summariseRerun([result("checkout-001", "failed", "Error: still 500")], ["checkout-001"], withVerdicts);
    expect(text).toBe("0 of 1 passed. checkout-001 still fails and the classifier calls it an app defect: Error: still 500");
  });

  it("names a non-defect verdict without inviting a ticket", () => {
    const text = summariseRerun([result("auth-001", "timedOut", "TimeoutError: page.goto")], ["auth-001"], withVerdicts);
    expect(text).toBe("0 of 1 passed. auth-001 still fails and the classifier called it an environment error: TimeoutError: page.goto");
  });
});

describe("resultData", () => {
  it("keeps only what the chat renders, with the error trimmed", () => {
    const d = resultData("c1", [result("checkout-001", "failed", "x".repeat(500))], catalogue);
    expect(d).toEqual({ kind: "rerun_result", runId: "c1", results: [{ id: "checkout-001", title: "checkout-001", status: "failed", error: "x".repeat(300), durationMs: 1200 }] });
  });

  it("carries the original run's verdict and defect id so the chat can offer a ticket", () => {
    const d = resultData("c1", [result("checkout-001", "failed", "Error: still 500"), result("auth-001", "passed")], withVerdicts);
    expect(d.results[0]).toMatchObject({ id: "checkout-001", verdict: { class: "defect", confidence: 0.9 }, defectId: "DEF-1-checkout-001" });
    expect(d.results[1]).toEqual({ id: "auth-001", title: "auth-001", status: "passed", durationMs: 1200, verdict: { class: "env", confidence: 0.6 } });
    expect("defectId" in d.results[1]).toBe(false);
  });
});
