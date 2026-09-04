import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreSignals, classifyOne, afterClassify, type Evidence } from "../src/nodes/classify.js";
import { makeDefect } from "../src/nodes/defects.js";
import { initialState, type Classification, type Flow, type TestResult } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

const flow: Flow = {
  id: "checkout-002", title: "Place order", category: "happy", priority: "P1", preconditions: ["logged_in"], source: "explored",
  steps: [{ action: "goto", target: "/checkout" }, { action: "click", role: "button", name: "Place order", intent: "submit the order" }],
  expected: [{ type: "visible", role: "status", text_contains: "Order confirmed" }],
};
const base: TestResult = { id: "checkout-002", file: "x", title: "Place order", status: "failed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };

describe("scoreSignals", () => {
  it("renamed button: near twin exists, no network error -> script", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "Timeout waiting for getByRole('button', { name: 'Place order' })" }, flow, snapshotAtFailure: `- button "Complete purchase"`, controlPassed: null, sameLocatorFailures: 0 };
    const { weights } = scoreSignals(e);
    expect(weights.script).toBeGreaterThan(weights.defect);
  });
  it("500 during failing step and control fails -> defect", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "expect(locator).toContainText failed", network: [{ method: "POST", url: "http://x/api/coupon", status: 500, at: 1 }] }, flow, snapshotAtFailure: `- button "Place order"`, controlPassed: false, sameLocatorFailures: 0 };
    const { weights, evidence } = scoreSignals(e);
    expect(weights.defect).toBeGreaterThanOrEqual(0.7);
    expect(evidence.join(" ")).toMatch(/500/);
  });
  it("goto timeout -> env", () => {
    const e: Evidence = { test: { ...base, failingStep: 0, error: "page.goto: net::ERR_CONNECTION_REFUSED" }, flow, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0 };
    expect(scoreSignals(e).weights.env).toBeGreaterThanOrEqual(0.6);
  });
  it("still failing after a rerun adds defect weight", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "expect(locator).toContainText failed", network: [{ method: "POST", url: "http://x/api/coupon", status: 500, at: 1 }] }, flow, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0, previousStatus: "failed" };
    expect(scoreSignals(e).weights.defect).toBeGreaterThanOrEqual(0.8);
  });
  it("passes on rerun -> flaky", () => {
    const e: Evidence = { test: { ...base, status: "passed" }, flow, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0, previousStatus: "failed" };
    expect(scoreSignals(e).weights.flaky).toBeGreaterThanOrEqual(0.6);
  });
  it("tolerates a relative or malformed network URL instead of throwing", () => {
    const e: Evidence = { test: { ...base, network: [{ method: "POST", url: "/api/relative", status: 500, at: 1 }] }, flow, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0 };
    expect(() => scoreSignals(e)).not.toThrow();
    expect(scoreSignals(e).evidence.join(" ")).toContain("/api/relative");
  });
});

describe("classifyOne", () => {
  it("acts when confidence >= 0.8", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "Timeout waiting for getByRole('button', { name: 'Place order' })" }, flow, snapshotAtFailure: `- button "Complete purchase"`, controlPassed: true, sameLocatorFailures: 2 };
    const c = classifyOne(e, 0, 0);
    expect(c.class).toBe("script");
    expect(c.action).toBe("heal");
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it("asks for a rerun in the 0.5-0.8 band when reruns remain", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "expect(locator).toContainText failed\nExpected: Order confirmed\nReceived: Order placed" }, flow, snapshotAtFailure: `- button "Place order"`, controlPassed: true, sameLocatorFailures: 0 };
    const c = classifyOne(e, 0, 0);
    expect(c.confidence).toBeGreaterThanOrEqual(0.5);
    expect(c.confidence).toBeLessThan(0.8);
    expect(c.action).toBe("rerun");
  });
  it("marks needs_human below 0.5", () => {
    const e: Evidence = { test: { ...base, error: "something odd" }, flow, snapshotAtFailure: "", controlPassed: null, sameLocatorFailures: 0 };
    const c = classifyOne(e, 2, 2);
    expect(c.class).toBe("needs_human");
    expect(c.action).toBe("needs_human");
  });
  it("does not heal past 2 attempts", () => {
    const e: Evidence = { test: { ...base, failingStep: 1, error: "Timeout waiting for getByRole('button', { name: 'Place order' })" }, flow, snapshotAtFailure: `- button "Complete purchase"`, controlPassed: true, sameLocatorFailures: 2 };
    expect(classifyOne(e, 2, 0).action).toBe("escalate");
  });
});

describe("afterClassify", () => {
  it("routes based on the action mix and logs exactly one decision per call", () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-classify-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const deps = { bus, llm: new FakeLlmClient({}) };
    const state = initialState({ runId: "r", url: "http://example.com" });
    const decisionCount = () => bus.replay().filter((ev) => ev.type === "decision").length;

    let before = decisionCount();
    const envClassifications: Classification[] = [{ test: "a", class: "env", confidence: 0.9, evidence: [], action: "stop" }];
    expect(afterClassify({ ...state, classifications: envClassifications }, deps)).toBe("report");
    expect(decisionCount() - before).toBe(1);

    before = decisionCount();
    const healClassifications: Classification[] = [
      { test: "a", class: "script", confidence: 0.9, evidence: [], action: "heal" },
      { test: "b", class: "defect", confidence: 0.6, evidence: [], action: "rerun" },
    ];
    expect(afterClassify({ ...state, classifications: healClassifications }, deps)).toBe("heal");
    expect(decisionCount() - before).toBe(1);

    before = decisionCount();
    const rerunClassifications: Classification[] = [{ test: "a", class: "defect", confidence: 0.6, evidence: [], action: "rerun" }];
    expect(afterClassify({ ...state, classifications: rerunClassifications }, deps)).toBe("rerun");
    expect(decisionCount() - before).toBe(1);

    before = decisionCount();
    expect(afterClassify({ ...state, classifications: [] }, deps)).toBe("report");
    expect(decisionCount() - before).toBe(1);
  });
});

describe("makeDefect", () => {
  it("builds a ticket from a P1 logged_in flow, its trace path, and the evidence list", () => {
    const state = {
      ...initialState({ runId: "r", url: "http://example.com" }),
      plan: [flow],
      results: { tests: [{ ...base, tracePath: "/tmp/t/trace.zip" }], at: new Date().toISOString() },
      defects: [],
    };
    const evidence = ["POST /api/coupon returned 500"];
    const defect = makeDefect(state, "checkout-002", "500 Internal Server Error\nfull stack trace here", evidence);

    expect(defect.id.startsWith("DEF-1-")).toBe(true);
    expect(defect.severity).toBe("high");
    expect(defect.repro_steps[0]).toBe("Log in with the test credentials");
    expect(defect.repro_steps.slice(1)).toEqual(
      flow.steps.map((s, i) => `${i + 1}. ${s.action} ${s.target ?? `${s.role} "${s.name}"`}${s.value ? ` with "${s.value}"` : ""}`),
    );
    expect(defect.attachments).toEqual(["/tmp/t/trace.zip"]);
    expect(defect.actual).toBe("500 Internal Server Error");
  });
});
