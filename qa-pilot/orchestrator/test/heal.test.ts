import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { crawl } from "../src/nodes/explore.js";
import { healNode, patchStep, guardExpects } from "../src/nodes/heal.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { initialState, type Classification, type Flow, type HealRecord, type SiteMap, type TestResult } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

const src = `import { test, expect } from 'x';
// flow: checkout-002 | category: happy | source: explored
test('Place order', async ({ page, login }) => {
  await login();
  // step 0
  await page.goto('/products/p1');
  // step 1
  await page.getByRole('button', { name: 'Add to cart' }).click();
  // step 2
  await page.goto('/checkout');
  // step 3
  await page.getByRole('textbox', { name: 'Full name' }).fill('Demo');
  // step 4
  await page.getByRole('textbox', { name: 'Address' }).fill('1 Main St');
  // step 5
  await page.getByRole('textbox', { name: 'Card number' }).fill('4242424242424242');
  // step 6
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByRole('status')).toContainText('Order');
});
`;

describe("patchStep / guardExpects", () => {
  it("replaces only the action line after the step comment", () => {
    const out = patchStep(src, 6, "await page.getByRole('button', { name: 'Complete purchase' }).click();");
    expect(out).toContain("// step 6\n  await page.getByRole('button', { name: 'Complete purchase' }).click();");
    expect(out).toContain("{ name: 'Card number' }");
    expect(guardExpects(src, out)).toBe(true);
  });
  it("guard fails when an expect line changes", () => {
    expect(guardExpects(src, src.replace("toContainText('Order')", "toContainText('x')"))).toBe(false);
    expect(guardExpects(src, src.replace("  await expect(page.getByRole('status')).toContainText('Order');\n", ""))).toBe(false);
  });
});

let shop: Awaited<ReturnType<typeof startShop>>;
let siteMap: SiteMap;
beforeAll(async () => {
  shop = await startShop();
  const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base });
  siteMap = await crawl(kit, { credentials: { username: "demo@shop.test", password: "demo1234" } });
  await kit.close();
});
afterAll(async () => { await shop.stop(); });

const flow: Flow = {
  id: "checkout-002", title: "Place order", category: "happy", priority: "P1", preconditions: ["logged_in"], source: "explored",
  steps: [
    { action: "goto", target: "/products/p1", intent: "open a product" },
    { action: "click", role: "button", name: "Add to cart", intent: "add it to the cart" },
    { action: "goto", target: "/checkout", intent: "open checkout" },
    { action: "fill", role: "textbox", name: "Full name", value: "Demo", intent: "enter name" },
    { action: "fill", role: "textbox", name: "Address", value: "1 Main St", intent: "enter address" },
    { action: "fill", role: "textbox", name: "Card number", value: "4242424242424242", intent: "enter card" },
    { action: "click", role: "button", name: "Place order", intent: "submit the order" },
  ],
  expected: [{ type: "visible", role: "status", text_contains: "Order" }],
};

describe("healNode", () => {
  it("patches the renamed button locator and keeps expects intact", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/checkout-002.spec.ts";
    writeFileSync(file, src);
    try {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: true }) });
      const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
      const llm = new FakeLlmClient({ heal: { role: "button", name: "Complete purchase", reason: "same submit control, renamed", confidence: 0.9 } });
      const failed: TestResult = { id: "checkout-002", file, title: "Place order", status: "failed", error: "Timeout waiting for getByRole('button', { name: 'Place order' })", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
      const state = {
        ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow],
        results: { tests: [failed], at: "" },
        classifications: [{ test: "checkout-002", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }],
      };
      const update = await healNode(state, { bus, llm, headless: true });
      expect(update.healAttempts).toEqual({ "checkout-002": 1 });
      expect(update.testsToRun).toEqual(["checkout-002"]);
      expect((update.healLog as HealRecord[])[0].accepted).toBe(true);
      expect((update.healLog as HealRecord[])[0].after).toContain("Complete purchase");
      const patched = readFileSync(file, "utf8");
      expect(patched).toContain("{ name: 'Complete purchase' }");
      expect(patched).toContain("await expect(page.getByRole('status')).toContainText('Order');");
      expect(readFileSync(process.env.QA_PILOT_OUTPUT + "r/heal-log.json", "utf8")).toContain("Complete purchase");
    } finally {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: false }) });
    }
  }, 120_000);

  it("reclassifies as defect when no element accomplishes the intent", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal2-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/checkout-002.spec.ts";
    writeFileSync(file, src);
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: { role: "button", name: "Nothing", reason: "none", confidence: 0 } });
    const failed: TestResult = { id: "checkout-002", file, title: "Place order", status: "failed", error: "x", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow], results: { tests: [failed], at: "" }, classifications: [{ test: "checkout-002", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }] };
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual([]);
    expect((update.classifications as Classification[])[0].class).toBe("defect");
    expect(update.defects).toHaveLength(1);
  }, 120_000);
});
