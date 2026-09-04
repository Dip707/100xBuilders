import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startShop } from "./helpers/shop.js";
import { BrowserToolkit, expectationCode } from "../src/browser/toolkit.js";
import { resolveLocator } from "../src/browser/locators.js";

let shop: Awaited<ReturnType<typeof startShop>>;
let kit: BrowserToolkit;
beforeAll(async () => {
  shop = await startShop();
  kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base });
});
afterAll(async () => {
  await kit.close();
  await shop.stop();
});

describe("resolveLocator", () => {
  it("prefers getByRole and emits matching code", async () => {
    const page = await kit.newPage();
    await page.goto(shop.base + "/login");
    const r = await resolveLocator(page, { role: "button", name: "Sign in" });
    expect(r?.strategy).toBe("role");
    expect(r?.code).toBe("page.getByRole('button', { name: 'Sign in' })");
    await page.close();
  });
  it("falls back to getByLabel for a textbox whose role lookup is ambiguous", async () => {
    const page = await kit.newPage();
    await page.goto(shop.base + "/login");
    const r = await resolveLocator(page, { role: "textbox", name: "Email" });
    expect(["role", "label"]).toContain(r?.strategy);
    await page.close();
  });
  it("returns null when nothing matches", async () => {
    const page = await kit.newPage();
    await page.goto(shop.base + "/login");
    expect(await resolveLocator(page, { role: "button", name: "Launch rocket" })).toBeNull();
    await page.close();
  });
  it("falls back to exact match with exact:true when the loose match is ambiguous", async () => {
    const page = await kit.newPage();
    await page.setContent("<button>Save</button><button>Save draft</button>");
    const r = await resolveLocator(page, { role: "button", name: "Save" });
    expect(r?.strategy).toBe("role");
    expect(r?.code).toBe("page.getByRole('button', { name: 'Save', exact: true })");
    await page.close();
  });
});

describe("BrowserToolkit.act and checkExpectation", () => {
  it("runs the wrong-password flow live", async () => {
    const page = await kit.newPage();
    const goto = await kit.act(page, { action: "goto", target: "/login" });
    expect(goto?.code).toBe("");
    await kit.act(page, { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test" });
    await kit.act(page, { action: "fill", role: "textbox", name: "Password", value: "wrong" });
    const start = page.url();
    await kit.act(page, { action: "click", role: "button", name: "Sign in" });
    const alert = await kit.checkExpectation(page, { type: "visible", role: "alert", text_contains: "Invalid" }, start);
    expect(alert.ok).toBe(true);
    const url = await kit.checkExpectation(page, { type: "url_stays", value: "/login" }, start);
    expect(url.ok).toBe(true);
    await page.close();
  });
  it("returns null from act when the element is missing", async () => {
    const page = await kit.newPage();
    await kit.act(page, { action: "goto", target: "/login" });
    expect(await kit.act(page, { action: "click", role: "button", name: "Nope" })).toBeNull();
    await page.close();
  });
});

describe("BrowserToolkit.newContext", () => {
  it("gives a fresh, unauthenticated context", async () => {
    const ctx = await kit.newContext();
    const page = await ctx.newPage();
    await page.goto(shop.base + "/orders");
    expect(page.url()).toContain("/login");
    await ctx.close();
  });
});

describe("expectationCode", () => {
  it("emits expect lines", () => {
    expect(expectationCode({ type: "visible", role: "alert", text_contains: "Invalid" })).toBe("await expect(page.getByRole('alert')).toContainText('Invalid');");
    expect(expectationCode({ type: "url_stays", value: "/login" })).toBe("await expect(page).toHaveURL(/\\/login/);");
    expect(expectationCode({ type: "url_contains", value: "/products" })).toBe("await expect(page).toHaveURL(/\\/products/);");
    expect(expectationCode({ type: "visible", role: "heading", name: "Products" })).toBe("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
  });
});

describe("checkExpectation locator resolution", () => {
  it("falls back to exact:true when the loose role match is ambiguous, and emits that code", async () => {
    const page = await kit.newPage();
    await page.setContent('<a href="/orders">Orders</a><a href="/orders/new">View orders</a>');
    const r = await kit.checkExpectation(page, { type: "visible", role: "link", name: "Orders" }, page.url());
    expect(r.ok).toBe(true);
    expect(r.code).toBe("await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();");
    await page.close();
  });
  it("keeps the loose locator when it is unambiguous", async () => {
    const page = await kit.newPage();
    await page.setContent('<a href="/orders">Orders</a>');
    const r = await kit.checkExpectation(page, { type: "visible", role: "link", name: "Orders" }, page.url());
    expect(r.ok).toBe(true);
    expect(r.code).toBe("await expect(page.getByRole('link', { name: 'Orders' })).toBeVisible();");
    await page.close();
  });
});

describe("unique test data", () => {
  it("substitutes {{unique}} in fills with a per-toolkit token", async () => {
    const page = await kit.newPage();
    await page.setContent('<label>Email <input type="email"></label>');
    expect(kit.unique).toMatch(/^[a-z0-9]{4,}$/);
    await kit.act(page, { action: "fill", role: "textbox", name: "Email", value: "user-{{unique}}@test.com" });
    expect(await page.getByRole("textbox", { name: "Email" }).inputValue()).toBe(`user-${kit.unique}@test.com`);
    await page.close();
  });
  it("substitutes {{unique}} in expectations and emits a template literal", async () => {
    const page = await kit.newPage();
    await page.setContent(`<p>Signed in as user-${kit.unique}@test.com</p>`);
    const r = await kit.checkExpectation(page, { type: "text_contains", text_contains: "Signed in as user-{{unique}}@test.com" }, page.url());
    expect(r.ok).toBe(true);
    expect(r.code).toBe("await expect(page.locator('body')).toContainText(`Signed in as user-${unique}@test.com`);");
    await page.close();
  });
});
