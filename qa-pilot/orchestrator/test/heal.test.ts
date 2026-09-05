import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { crawl } from "../src/nodes/explore.js";
import { healNode, patchStep, guardExpects, pickAssertionTarget, MIN_ASSERTION_NAME_SIMILARITY } from "../src/nodes/heal.js";
import { nameSimilarity } from "../src/browser/snapshot.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { initialState, type Classification, type Flow, type HealRecord, type SiteMap, type TestResult } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

// The step healer now answers with an index into a numbered CANDIDATES list rather than a
// free-text name, so a canned test answer has to find its target's number in that list
// instead of stating the name directly. Mirrors what a real model does when reading the
// rendered `renderCandidates` output embedded in the prompt input.
function candidateIndex(input: string, name: string): number {
  const line = input.split("\n").find((l) => l.includes(`"${name}"`));
  if (!line) throw new Error(`candidate "${name}" not found in healer input:\n${input}`);
  return Number(/^(\d+):/.exec(line)![1]);
}

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
      const llm = new FakeLlmClient({ heal: (input: string) => ({ reason: "same submit control, renamed", candidate: candidateIndex(input, "Complete purchase"), confidence: 0.9 }) });
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
    const llm = new FakeLlmClient({ heal: { reason: "none", candidate: 0, confidence: 0 } });
    const failed: TestResult = { id: "checkout-002", file, title: "Place order", status: "failed", error: "x", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow], results: { tests: [failed], at: "" }, classifications: [{ test: "checkout-002", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }] };
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual([]);
    expect((update.classifications as Classification[])[0].class).toBe("defect");
    expect(update.defects).toHaveLength(1);
  }, 120_000);

  it("reclassifies as defect instead of throwing when the healer names an out-of-range candidate", async () => {
    // The step healer can only choose an index into the numbered candidate list it was shown,
    // but a model can still hallucinate a number past the end of that list. That must land as
    // an ordinary defect classification - never an uncaught index into `undefined`.
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal-oor-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/checkout-002.spec.ts";
    writeFileSync(file, src);
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: { reason: "the checkout button moved", candidate: 9999, confidence: 0.9 } });
    const failed: TestResult = { id: "checkout-002", file, title: "Place order", status: "failed", error: "x", failingStep: 6, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow], results: { tests: [failed], at: "" }, classifications: [{ test: "checkout-002", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }] };
    const update = await healNode(state, { bus, llm, headless: true });
    expect(update.testsToRun).toEqual([]);
    expect((update.classifications as Classification[])[0].class).toBe("defect");
    expect(update.defects).toHaveLength(1);
    expect(JSON.stringify(update.defects)).toContain("out of range");
    expect(readFileSync(file, "utf8")).toBe(src);
  }, 120_000);

  it("isolates a per-target failure (missing spec file) instead of letting it escape healNode", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal3-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const bogusFile = process.env.QA_PILOT_OUTPUT + "r/tests/does-not-exist.spec.ts";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: { reason: "same submit control, renamed", candidate: 0, confidence: 0.9 } });
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

describe("MIN_ASSERTION_NAME_SIMILARITY", () => {
  // guardExpects compares signatures with the target's name stripped, so on its own it would
  // accept "Log In" -> "Sign Up". This threshold is what keeps that swap out.
  it("admits cosmetic renames and rejects semantic swaps", () => {
    for (const [a, b] of [["Log In", "Log in"], ["Add to cart", "Add to Cart"], ["Sign In", "Sign in"], ["Place Order", "Place order"]])
      expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(MIN_ASSERTION_NAME_SIMILARITY);
    for (const [a, b] of [["Log In", "Sign Up"], ["Pay now", "Save for later"], ["Place Order", "Cancel Order"], ["Continue", "Cancel"], ["Place order", "Complete purchase"]])
      expect(nameSimilarity(a, b)).toBeLessThan(MIN_ASSERTION_NAME_SIMILARITY);
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
  // `asserted` is the accessible name the spec and the plan claim the heading has; the live
  // shop heading is "Products". How far `asserted` sits from it decides whether the healer is
  // allowed to re-target or must escalate.
  function setup(prefix: string, suggestion: unknown, asserted = "Product catalogue") {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), prefix)) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/products-001.spec.ts";
    const src = catalogueSrc.replace("Product catalogue", asserted);
    writeFileSync(file, src);
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({ heal: suggestion });
    const failed: TestResult = { id: "products-001", file, title: "Catalogue lists products", status: "failed", error: catalogueError.replace("Product catalogue", asserted), failingExpect: 1, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
    const flow: Flow = { ...catalogueFlow, expected: [catalogueFlow.expected[0], { ...catalogueFlow.expected[1], name: asserted }] };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [flow], results: { tests: [failed], at: "" }, classifications: [{ test: "products-001", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }] };
    return { file, src, bus, llm, state };
  }

  it("re-targets the assertion across a cosmetic rename and keeps the matcher", async () => {
    // "PRODUCTS" -> "Products" is a pure casing difference (similarity 1.0): the assertion
    // still proves the same heading is on the page, so re-targeting it is a locator fix.
    const { file, bus, llm, state } = setup("qa-heal-exp-", { role: "heading", name: "Products", reason: "the catalogue heading is titled Products", confidence: 0.9 }, "PRODUCTS");
    const update = await healNode(state, { bus, llm, headless: true });
    expect(llm.calls).toBe(0);
    expect(update.testsToRun).toEqual(["products-001"]);
    const record = (update.healLog as HealRecord[])[0];
    expect(record.accepted).toBe(true);
    expect(record.expectation).toBe(1);
    expect(record.after).toBe("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
    const patched = readFileSync(file, "utf8");
    expect(patched).toContain("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
    expect(patched).not.toContain("PRODUCTS");
    expect(patched).toContain("await expect(page).toHaveURL(/\\/products/);");
  }, 120_000);

  it("refuses to re-target an assertion across a semantic rename and escalates instead", async () => {
    // "Product catalogue" -> "Products" (similarity 0.35) is the false-heal shape: same role,
    // live-visible, and identical under expectSignature, but it no longer proves the page has
    // the heading the plan asked about. The suite must not absorb that silently.
    const { file, src, bus, llm, state } = setup("qa-heal-exp3-", { role: "heading", name: "Products", reason: "the catalogue heading is titled Products", confidence: 0.9 });
    const update = await healNode(state, { bus, llm, headless: true });
    expect(llm.calls).toBe(0);
    expect(update.testsToRun).toEqual([]);
    expect((update.classifications as Classification[])[0].class).toBe("defect");
    expect(JSON.stringify(update.defects)).toContain("name similarity");
    expect(readFileSync(file, "utf8")).toBe(src);
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
      const llm = new FakeLlmClient({ heal: (input: string) => ({ reason: "same submit control, renamed", candidate: candidateIndex(input, "Complete purchase"), confidence: 0.9 }) });
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

const assertionSrc = `import { test, expect } from 'x';
// flow: checkout-003 | category: happy | source: explored
test('Checkout control present', async ({ page }) => {
  // step 0
  await page.goto('/checkout');
  await expect(page.getByRole('button', { name: 'Place order' })).toBeVisible();
});
`;

const assertionFlow: Flow = {
  id: "checkout-003", title: "Checkout control present", category: "happy", priority: "P1", preconditions: [], source: "explored",
  steps: [{ action: "goto", target: "/checkout", intent: "open checkout" }],
  expected: [{ type: "visible", role: "button", name: "Place order" }],
};

describe("healNode assertion guard", () => {
  it("refuses to re-target an assertion onto a semantically different element and escalates instead", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-heal-assert-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "r/tests", { recursive: true });
    const file = process.env.QA_PILOT_OUTPUT + "r/tests/checkout-003.spec.ts";
    writeFileSync(file, assertionSrc);
    try {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: true }) });
      const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
      // The healer names a real, same-role, live-visible element, so it clears every other
      // check in the branch. Only the name-similarity gate stands between this suggestion and
      // a green suite on an app that no longer has the control the test asserts.
      const llm = new FakeLlmClient({ heal: { role: "button", name: "Complete purchase", reason: "the submit control was renamed", confidence: 0.95 } });
      const failed: TestResult = { id: "checkout-003", file, title: "Checkout control present", status: "failed", error: "expect(getByRole('button', { name: 'Place order' })).toBeVisible() failed", failingExpect: 0, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 };
      const state = {
        ...initialState({ runId: "r", url: shop.base }), siteMap, plan: [assertionFlow],
        results: { tests: [failed], at: "" },
        classifications: [{ test: "checkout-003", class: "script" as const, confidence: 0.9, evidence: [], action: "heal" as const }],
      };
      const update = await healNode(state, { bus, llm, headless: true });
      expect(llm.calls).toBe(0);
      expect(update.testsToRun).toEqual([]);
      expect((update.classifications as Classification[])[0].class).toBe("defect");
      expect((update.classifications as Classification[])[0].action).toBe("escalate");
      expect(update.defects).toHaveLength(1);
      expect(JSON.stringify(update.defects)).toContain("name similarity");
      expect(readFileSync(file, "utf8")).toBe(assertionSrc);
    } finally {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: false }) });
    }
  }, 120_000);
});

describe("pickAssertionTarget", () => {
  const snapshot = ['- heading "Products"', '- link "Products"', '- button "Log In"', '- heading "Cart"'].join("\n");

  it("picks the same-role near-copy and reports the similarity it turned on", () => {
    const got = pickAssertionTarget(snapshot, { role: "heading", name: "PRODUCTS" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.suggestion.role).toBe("heading");
    expect(got.suggestion.name).toBe("Products");
    expect(got.suggestion.confidence).toBe(1);
  });

  it("never crosses roles, even when another role carries the exact name", () => {
    // A link named "Products" is present, but the assertion is about a heading. Re-targeting
    // across roles would change what the test proves, so this escalates rather than healing.
    const got = pickAssertionTarget('- link "Products"\n- button "Products"', { role: "heading", name: "Products" });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toContain("no heading element remains");
  });

  it("escalates on a semantic rename and names the number that blocked it", () => {
    const got = pickAssertionTarget(snapshot, { role: "heading", name: "Product catalogue" });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toContain("name similarity");
    expect(got.why).toContain("Products");
  });

  it("escalates when the role has vanished from the page entirely", () => {
    const got = pickAssertionTarget('- button "Log In"', { role: "heading", name: "Products" });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toContain("no heading element remains");
  });
});
