import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

  it("isolates a per-target failure (missing spec file) instead of letting it escape healNode", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal3-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const bogusFile = process.env.QA_PILOT_OUTPUT + "r/tests/does-not-exist.spec.ts";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: { role: "button", name: "Complete purchase", reason: "same submit control, renamed", confidence: 0.9 } });
    const failed: TestResult = { id: "checkout-002", file: bogusFile, title: "Place order", status: "failed", error: "x", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const classification: Classification = { test: "checkout-002", class: "script", confidence: 0.9, evidence: [], action: "heal" };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow], results: { tests: [failed], at: "" }, classifications: [classification] };
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual([]);
    const updatedClassification = (update.classifications as Classification[])[0];
    expect(updatedClassification.class).toBe("script");
    expect(updatedClassification.action).toBe("heal");
    const events = bus.replay();
    expect(events.some((e) => e.type === "error" && e.node === "heal")).toBe(true);
    expect(existsSync(process.env.QA_PILOT_OUTPUT + "r/heal-log.json")).toBe(true);
  }, 120_000);
});

describe("guardExpects on assertion targets", () => {
  const line = "  await expect(page.getByRole('status')).toContainText('Order');\n";
  it("allows re-targeting an assertion to another element of the same role", () => {
    expect(guardExpects(src, src.replace(line, "  await expect(page.getByRole('status', { name: 'Order placed' })).toContainText('Order');\n"))).toBe(true);
    expect(guardExpects(src, src.replace(line, "  await expect(page.getByRole('status', { name: 'Order placed', exact: true })).toContainText('Order');\n"))).toBe(true);
  });
  it("rejects a change of role, a swap to the page body, or a change of matcher or value", () => {
    expect(guardExpects(src, src.replace(line, "  await expect(page.getByRole('link')).toContainText('Order');\n"))).toBe(false);
    expect(guardExpects(src, src.replace(line, "  await expect(page.locator('body')).toContainText('Order');\n"))).toBe(false);
    expect(guardExpects(src, src.replace(line, "  await expect(page.getByRole('status')).toBeVisible();\n"))).toBe(false);
    expect(guardExpects(src, src.replace(line, "  await expect(page.getByRole('status')).not.toContainText('Order');\n"))).toBe(false);
  });
});

const catalogueSrc = `import { test, expect } from 'x';
// flow: products-001 | category: happy | source: explored
test('Catalogue lists products', async ({ page }) => {
  // step 0
  await page.goto('/products');
  await expect(page).toHaveURL(/\\/products/);
  await expect(page.getByRole('heading', { name: 'Product catalogue' })).toBeVisible();
});
`;
const catalogueFlow: Flow = {
  id: "products-001", title: "Catalogue lists products", category: "happy", priority: "P2", preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: "/products", intent: "open the catalogue" }],
  expected: [{ type: "url_contains", value: "/products" }, { type: "visible", role: "heading", name: "Product catalogue" }],
};
const catalogueError = `Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('heading', { name: 'Product catalogue' })\nExpected: visible\nTimeout: 5000ms\nError: element(s) not found`;

describe("healNode on a failing assertion", () => {
  function setup(prefix: string, suggestion: unknown) {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), prefix)) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/products-001.spec.ts";
    writeFileSync(file, catalogueSrc);
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: suggestion });
    const failed: TestResult = { id: "products-001", file, title: "Catalogue lists products", status: "failed", error: catalogueError, failingExpect: 1, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [catalogueFlow], results: { tests: [failed], at: "" }, classifications: [{ test: "products-001", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }] };
    return { file, bus, llm, state };
  }

  it("re-targets the assertion to the renamed heading and keeps the matcher", async () => {
    const { file, bus, llm, state } = setup("qa-heal-exp-", { role: "heading", name: "Products", reason: "the catalogue heading is titled Products", confidence: 0.9 });
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual(["products-001"]);
    const record = (update.healLog as HealRecord[])[0];
    expect(record.accepted).toBe(true);
    expect(record.expectation).toBe(1);
    expect(record.after).toBe("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
    const patched = readFileSync(file, "utf8");
    expect(patched).toContain("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
    expect(patched).not.toContain("Product catalogue");
    expect(patched).toContain("await expect(page).toHaveURL(/\\/products/);");
  }, 120_000);

  it("refuses to re-target an assertion to a different role and escalates instead", async () => {
    const { file, bus, llm, state } = setup("qa-heal-exp2-", { role: "link", name: "Products", reason: "there is a Products link", confidence: 0.9 });
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual([]);
    expect((update.classifications as Classification[])[0].class).toBe("defect");
    expect(readFileSync(file, "utf8")).toBe(catalogueSrc);
  }, 120_000);
});

describe("healNode verifies against the expectations the generator actually emitted", () => {
  it("accepts a heal when the plan's expectation was re-targeted at generation time", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal-eff-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/checkout-002.spec.ts";
    writeFileSync(file, src);
    try {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: true }) });
      const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
      const llm = new FakeLlmClient({ heal: { role: "button", name: "Complete purchase", reason: "same submit control, renamed", confidence: 0.9 } });
      const failed: TestResult = { id: "checkout-002", file, title: "Place order", status: "failed", error: "locator.click: Timeout waiting for getByRole('button', { name: 'Place order' })", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
      // The plan guessed a URL the app never reaches; the generator replaced it with what it saw.
      const planned: Flow = { ...flow, expected: [{ type: "url_contains", value: "/orders" }] };
      const state = {
        ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [planned],
        expectations: { "checkout-002": flow.expected },
        results: { tests: [failed], at: "" },
        classifications: [{ test: "checkout-002", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }],
      };
      const update = await healNode(state, { bus, llm, headless: true });
      expect(update.testsToRun).toEqual(["checkout-002"]);
      expect((update.healLog as HealRecord[])[0].accepted).toBe(true);
    } finally {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: false }) });
    }
  }, 120_000);
});
