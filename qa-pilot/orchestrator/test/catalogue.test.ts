import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogue, failedIds, renderCatalogue } from "../src/copilot/catalogue.js";
import type { RunRecord } from "../src/store/types.js";

const run: RunRecord = { id: "c1", userId: "u1", url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: "2026-09-05T10:00:00.000Z", finishedAt: "2026-09-05T10:09:00.000Z" };

function flow(id: string, title: string, category = "happy", preconditions: string[] = ["logged_in"]) {
  return { id, title, category, priority: "P1", preconditions, steps: [{ action: "goto", target: "/" }], expected: [{ type: "url_contains", value: "/" }], source: "explored" };
}

function seed(dir: string) {
  mkdirSync(dir + "tests", { recursive: true });
  writeFileSync(dir + "plan.json", JSON.stringify([
    flow("auth-001", "User logs in", "happy", ["logged_out"]),
    flow("checkout-001", "Shopper applies a coupon at checkout"),
    flow("checkout-002", "Shopper places an order"),
    flow("orders-001", "Shopper views order history"),
  ]));
  writeFileSync(dir + "tests/auth-001.spec.ts", "test('x', async ({ page }) => {});");
  writeFileSync(dir + "tests/checkout-001.spec.ts", "test('x', async ({ page, login }) => { await login(); });");
  writeFileSync(dir + "tests/checkout-002.spec.ts", "test('x', async ({ page, login }) => { await login(); });");
  // orders-001 was planned but never generated: no spec on disk.
  writeFileSync(dir + "results.json", JSON.stringify({ at: "x", tests: [
    { id: "auth-001", file: "a", title: "User logs in", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 900 },
    { id: "checkout-001", file: "b", title: "Shopper applies a coupon at checkout", status: "failed", error: "Error: expect(locator).toContainText(expected) failed\nLocator: getByRole('status')", network: [], consoleErrors: [], pageErrors: [], durationMs: 4000 },
    { id: "checkout-002", file: "c", title: "Shopper places an order", status: "timedOut", error: "Test timeout of 30000ms exceeded.", network: [], consoleErrors: [], pageErrors: [], durationMs: 30000 },
  ] }));
  writeFileSync(dir + "defects.json", JSON.stringify([{ id: "DEF-1-checkout-001", title: "coupon 500", severity: "critical", flow: "checkout-001", repro_steps: [], expected: "", actual: "", evidence: [], attachments: [] }]));
  writeFileSync(dir + "heal-log.json", JSON.stringify([{ test: "checkout-002", attempt: 1, step: 3, before: "old", after: "new", reason: "button renamed", confidence: 0.9, accepted: true }]));
  writeFileSync(dir + "events.jsonl", [
    JSON.stringify({ type: "test_result", runId: "c1", at: "t1", message: "checkout-001 classified script 0.5", data: { test: "checkout-001", class: "script", confidence: 0.5, evidence: [], action: "rerun" } }),
    JSON.stringify({ type: "test_result", runId: "c1", at: "t2", message: "checkout-001 classified defect 0.9", data: { test: "checkout-001", class: "defect", confidence: 0.9, evidence: ["POST /api/coupon returned 500"], action: "escalate", rationale: "server error" } }),
    JSON.stringify({ type: "test_result", runId: "c1", at: "t3", message: "checkout-001 failed", data: { id: "checkout-001", status: "failed" } }),
  ].join("\n") + "\n");
}

describe("buildCatalogue", () => {
  beforeEach(() => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-cat-")) + "/";
    seed(process.env.QA_PILOT_OUTPUT + "c1/");
  });

  it("joins plan, results, classifications, heals and defects per test", () => {
    const c = buildCatalogue(run);
    expect(c.runId).toBe("c1");
    expect(c.tests.map((t) => t.id)).toEqual(["auth-001", "checkout-001", "checkout-002", "orders-001"]);
    const coupon = c.tests.find((t) => t.id === "checkout-001")!;
    expect(coupon.status).toBe("failed");
    expect(coupon.signsIn).toBe(true);
    expect(coupon.generated).toBe(true);
    expect(coupon.error).toMatch(/^Error: expect\(locator\)/);
    expect(coupon.error!.length).toBeLessThanOrEqual(240);
    // The newest classification wins, and a plain result event is not a classification.
    expect(coupon.verdict).toEqual({ class: "defect", confidence: 0.9, action: "escalate", rationale: "server error" });
    expect(coupon.defectId).toBe("DEF-1-checkout-001");
    const order = c.tests.find((t) => t.id === "checkout-002")!;
    expect(order.status).toBe("timedOut");
    expect(order.heal).toEqual({ accepted: true, before: "old", after: "new", reason: "button renamed" });
    const login = c.tests.find((t) => t.id === "auth-001")!;
    expect(login.signsIn).toBe(false);
    expect(login.verdict).toBeUndefined();
  });

  it("marks a planned test with no spec as not generated and not run", () => {
    const orders = buildCatalogue(run).tests.find((t) => t.id === "orders-001")!;
    expect(orders.generated).toBe(false);
    expect(orders.status).toBe("not_run");
  });

  it("failedIds is every generated test whose last status is not passed", () => {
    expect(failedIds(buildCatalogue(run))).toEqual(["checkout-001", "checkout-002"]);
  });

  it("renders one line per test with the fields the model picks from", () => {
    const text = renderCatalogue(buildCatalogue(run));
    expect(text).toContain("run c1");
    expect(text).toContain("checkout-001 | failed | happy P1 | signs in | Shopper applies a coupon at checkout");
    expect(text).toContain("verdict defect 0.9 escalate");
    expect(text).toContain("defect DEF-1-checkout-001");
    expect(text).toContain("orders-001 | not generated");
  });

  it("copes with a run directory that has no artifacts", () => {
    const c = buildCatalogue({ ...run, id: "empty" });
    expect(c.tests).toEqual([]);
    expect(renderCatalogue(c)).toContain("no tests");
  });
});
