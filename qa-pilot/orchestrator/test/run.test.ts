import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { runPlaywright, parseJsonReport } from "../src/nodes/run.js";

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
