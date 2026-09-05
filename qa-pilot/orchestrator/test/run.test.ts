import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { runPlaywright, parseJsonReport } from "../src/nodes/run.js";
import { EventBus } from "../src/events.js";
import { memoryStore } from "../src/store/memory.js";
import { contextLoginSteps, rerunTests } from "../src/run.js";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { await shop.stop(); });

const FIXTURES = new URL("../../runner/fixtures", import.meta.url).pathname;

const passing = `import { test, expect } from '${FIXTURES}';
// flow: auth-002 | category: negative | source: explored
test('Login with wrong password shows error', async ({ page }) => {
  // step 0
  await page.goto('/login');
  // step 1
  await page.getByRole('textbox', { name: 'Email' }).fill('demo@shop.test');
  // step 2
  await page.getByRole('textbox', { name: 'Password' }).fill('wrong');
  // step 3
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid');
  await expect(page).toHaveURL(/\\/login/);
});
`;
const failing = `import { test, expect } from '${FIXTURES}';
// flow: checkout-001 | category: happy | source: explored
test('Coupon returns 500', async ({ page, login }) => {
  await login();
  // step 0
  await page.goto('/checkout');
  // step 1
  await page.getByRole('textbox', { name: 'Coupon code' }).fill('SAVE10');
  // step 2
  await page.getByRole('button', { name: 'Apply coupon' }).click();
  await expect(page.getByRole('status')).toContainText('Coupon applied');
});
`;

describe("runPlaywright", () => {
  it("runs generated specs, parses status, failing step and network evidence", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-run-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/tests/auth-002.spec.ts", passing);
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/tests/checkout-001.spec.ts", failing);
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    const loginSteps = [
      { action: "goto", target: "/login" },
      { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test" },
      { action: "fill", role: "textbox", name: "Password", value: "demo1234" },
      { action: "click", role: "button", name: "Sign in" },
    ] as const;
    const results = await runPlaywright({ runId: "r", baseUrl: shop.base, loginSteps: [...loginSteps] });
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
    const byId = Object.fromEntries(results.tests.map((t) => [t.id, t]));
    expect(byId["auth-002"].status).toBe("passed");
    expect(byId["checkout-001"].status).toBe("failed");
    expect(byId["checkout-001"].network.some((n) => n.url.endsWith("/api/coupon") && n.status === 500)).toBe(true);
    expect(byId["checkout-001"].error).toMatch(/Coupon applied|toContainText/);
    expect(byId["checkout-001"].tracePath).toMatch(/trace\.zip$/);
  }, 120_000);

  it("survives spawn failure when npx is not on PATH", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "qa-spawn-")) + "/";
    mkdirSync(outputDir + "spawnfail/tests", { recursive: true });
    process.env.QA_PILOT_OUTPUT = outputDir;
    const bus = new EventBus("spawnfail", outputDir + "spawnfail/");
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const results = await runPlaywright({ runId: "spawnfail", baseUrl: "http://127.0.0.1:1", loginSteps: [], bus });
      expect(results.tests).toEqual([]);
      const replay = bus.replay();
      const errorEvent = replay.find((e) => e.type === "error" && e.node === "run");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toMatch(/spawn/i);
    } finally {
      process.env.PATH = oldPath;
    }
  }, 10_000);
});

describe("parseJsonReport", () => {
  it("maps failing line to step index using step comments", () => {
    const report = {
      suites: [{ title: "checkout-001.spec.ts", file: "checkout-001.spec.ts", specs: [{ title: "T", file: "checkout-001.spec.ts", id: "x", ok: false, tests: [{ status: "unexpected", annotations: [], results: [{ status: "failed", duration: 5, error: { message: "boom" }, errorLocation: { file: "checkout-001.spec.ts", line: 8, column: 3 }, attachments: [], errors: [] }] }] }] }],
    };
    const dir = mkdtempSync(join(tmpdir(), "qa-parse-")) + "/";
    writeFileSync(dir + "checkout-001.spec.ts", failing);
    const [t] = parseJsonReport(report, dir, dir);
    expect(t.id).toBe("checkout-001");
    expect(t.failingStep).toBe(1);
  });
});

describe("runPlaywright live preview and recording", () => {
  it("announces test_start before the result, keeps a video per test, and leaves a finished live state", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-run-live-")) + "/";
    const runId = "live";
    mkdirSync(process.env.QA_PILOT_OUTPUT + `${runId}/tests`, { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + `${runId}/tests/auth-002.spec.ts`, passing);
    const bus = new EventBus(runId, process.env.QA_PILOT_OUTPUT + `${runId}/`);
    const results = await runPlaywright({ runId, baseUrl: shop.base, loginSteps: [], bus });

    const types = bus.replay().map((e) => e.type);
    expect(types.indexOf("test_start")).toBeGreaterThan(-1);
    expect(types.indexOf("test_start")).toBeLessThan(types.indexOf("test_result"));
    const start = bus.replay().find((e) => e.type === "test_start")!;
    expect(start.data).toMatchObject({ id: "auth-002", title: "Login with wrong password shows error" });

    const test = results.tests.find((t) => t.id === "auth-002")!;
    expect(test.videoPath).toMatch(/\/traces\/videos\/auth-002\.webm$/);
    expect(existsSync(test.videoPath!)).toBe(true);

    const state = JSON.parse(readFileSync(process.env.QA_PILOT_OUTPUT + `${runId}/live/auth-002/state.json`, "utf8"));
    expect(state.status).toBe("finished");
    expect(existsSync(process.env.QA_PILOT_OUTPUT + `${runId}/live/auth-002/frame.jpg`)).toBe(true);
  }, 120_000);
});

describe("parseJsonReport failing expectation", () => {
  it("maps a failing expect line to its index among the expect lines", () => {
    const report = {
      suites: [{ title: "checkout-001.spec.ts", file: "checkout-001.spec.ts", specs: [{ title: "T", file: "checkout-001.spec.ts", id: "x", ok: false, tests: [{ status: "unexpected", annotations: [], results: [{ status: "failed", duration: 5, error: { message: "boom" }, errorLocation: { file: "checkout-001.spec.ts", line: 11, column: 3 }, attachments: [], errors: [] }] }] }] }],
    };
    const dir = mkdtempSync(join(tmpdir(), "qa-parse-")) + "/";
    writeFileSync(dir + "checkout-001.spec.ts", failing);
    const [t] = parseJsonReport(report, dir, dir);
    expect(t.failingStep).toBeUndefined();
    expect(t.failingExpect).toBe(0);
  });
});

describe("runPlaywright concurrency", () => {
  it("keeps concurrent single-file invocations from reading each other's report or wiping each other's artifacts", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-run-par-")) + "/";
    const runId = "par";
    mkdirSync(process.env.QA_PILOT_OUTPUT + `${runId}/tests`, { recursive: true });
    const a = process.env.QA_PILOT_OUTPUT + `${runId}/tests/auth-002.spec.ts`;
    const b = process.env.QA_PILOT_OUTPUT + `${runId}/tests/auth-003.spec.ts`;
    writeFileSync(a, passing);
    writeFileSync(b, passing.replace("auth-002", "auth-003"));
    const bus = new EventBus(runId, process.env.QA_PILOT_OUTPUT + `${runId}/`);
    const [ra, rb] = await Promise.all([
      runPlaywright({ runId, baseUrl: shop.base, loginSteps: [], files: [a], bus }),
      runPlaywright({ runId, baseUrl: shop.base, loginSteps: [], files: [b], bus }),
    ]);
    expect(ra.tests.map((t) => t.id)).toEqual(["auth-002"]);
    expect(rb.tests.map((t) => t.id)).toEqual(["auth-003"]);
    expect(ra.tests[0].status).toBe("passed");
    expect(rb.tests[0].status).toBe("passed");
    expect(existsSync(ra.tests[0].videoPath!)).toBe(true);
    expect(existsSync(rb.tests[0].videoPath!)).toBe(true);
    const results = bus.replay().filter((e) => e.type === "test_result").map((e) => (e.data as { id: string }).id).sort();
    expect(results).toEqual(["auth-002", "auth-003"]);
  }, 120_000);
});

describe("runPlaywright on a missing step target", () => {
  it("fails fast with a locator error that names the step, instead of hitting the test timeout", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-run-missing-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const missing = passing.replace("{ name: 'Sign in' }", "{ name: 'Teleport' }");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/tests/auth-002.spec.ts", missing);
    const started = Date.now();
    const results = await runPlaywright({ runId: "r", baseUrl: shop.base, loginSteps: [] });
    const t = results.tests[0];
    expect(t.status).toBe("failed");
    expect(t.failingStep).toBe(3);
    expect(t.error).toMatch(/Teleport/);
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 120_000);
});

describe("rerunTests", () => {
  it("runs several specs in one invocation and merges every result into results.json", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-rerun-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/tests/auth-002.spec.ts", passing);
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/tests/checkout-001.spec.ts", failing);
    // A stale earlier result for one test and none for the other: the merge must replace the
    // first and add the second.
    writeFileSync(process.env.QA_PILOT_OUTPUT + "r/results.json", JSON.stringify({ tests: [{ id: "auth-002", file: "x", title: "old", status: "failed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "then" }));
    const store = memoryStore();
    await store.insertRun({ id: "r", userId: "u1", url: shop.base, hasPrd: false, status: "done", startedAt: new Date().toISOString() });
    const loginSteps = [
      { action: "goto" as const, target: "/login" },
      { action: "fill" as const, role: "textbox", name: "Email", value: "demo@shop.test" },
      { action: "fill" as const, role: "textbox", name: "Password", value: "demo1234" },
      { action: "click" as const, role: "button", name: "Sign in" },
    ];
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    try {
      const results = await rerunTests("r", ["auth-002", "checkout-001", "ghost-9"], loginSteps, store);
      expect(results.map((r) => [r.id, r.status]).sort()).toEqual([["auth-002", "passed"], ["checkout-001", "failed"]]);
    } finally {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
    }
    const merged = JSON.parse(readFileSync(process.env.QA_PILOT_OUTPUT + "r/results.json", "utf8"));
    expect(merged.tests.map((t: { id: string; status: string }) => [t.id, t.status]).sort()).toEqual([["auth-002", "passed"], ["checkout-001", "failed"]]);
    const rec = await store.getRun("r");
    expect(rec!.testsPassed).toBe(1);
    expect(rec!.testsFailed).toBe(1);
  }, 120_000);

  it("contextLoginSteps is null for a run this process never finished", () => {
    expect(contextLoginSteps("never-ran-here")).toBeNull();
  });
});
