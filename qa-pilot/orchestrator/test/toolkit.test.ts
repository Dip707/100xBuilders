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
  it("waits for a client-rendered element instead of failing on the first look", async () => {
    const page = await kit.newPage();
    await page.setContent('<div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = \'<label>Username <input></label><button>Sign in</button>\'; }, 1500);</script>');
    const r = await kit.act(page, { action: "fill", role: "textbox", name: "Username", value: "admin" });
    expect(r).not.toBeNull();
    expect(await page.getByRole("textbox", { name: "Username" }).inputValue()).toBe("admin");
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

describe("resolveLocator on pages with repeated controls", () => {
  it("acts on the first of several identical controls instead of giving up", async () => {
    // A product grid: one "Add to cart" per item. A tester told to add a product to the cart
    // presses the first one; the resolver used to reject the step as ambiguous.
    const page = await kit.newPage();
    await page.setContent(Array.from({ length: 6 }, (_, i) => `<div><h2>Item ${i}</h2><button>Add to cart</button></div>`).join(""));
    const r = await resolveLocator(page, { role: "button", name: "Add to cart" });
    expect(r?.strategy).toBe("role");
    expect(r?.code).toBe("page.getByRole('button', { name: 'Add to cart' }).first()");
    await r!.locator.click();
    await page.close();
  });
  it("still prefers the single exact match over the first loose one", async () => {
    const page = await kit.newPage();
    await page.setContent("<button>Add to cart</button><button>Add to cart now</button><button>Add to cart later</button>");
    const r = await resolveLocator(page, { role: "button", name: "Add to cart" });
    expect(r?.code).toBe("page.getByRole('button', { name: 'Add to cart', exact: true })");
    await page.close();
  });
  it("finds an icon-only control by its data-test attribute", async () => {
    // The crawler names an unlabelled control after its data-test attribute, so the planner
    // refers to it by that name. Playwright's getByTestId only reads data-testid.
    const page = await kit.newPage();
    await page.setContent('<a href="/cart" data-test="shopping-cart-link"><span class="badge">1</span></a>');
    const r = await resolveLocator(page, { role: "link", name: "shopping-cart-link" });
    expect(r?.strategy).toBe("testid");
    expect(r?.code).toBe("page.locator('[data-test=\"shopping-cart-link\"]')");
    await page.close();
  });
});

describe("screenshots never fail an agent", () => {
  it("returns an empty path when the screenshot cannot be taken", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const shots = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base, screenshotDir: mkdtempSync(join(tmpdir(), "qa-shots-")) });
    try {
      const page = await shots.newPage();
      await page.goto(shop.base + "/login");
      await page.close();
      // A closed page cannot be captured. That is a lost picture, not a failed step.
      await expect(shots.screenshot(page, "after close")).resolves.toBe("");
    } finally {
      await shots.close();
    }
  });
});

describe("checkExpectation on pages with repeated elements", () => {
  it("verifies against the first match and emits .first() when a name is repeated", async () => {
    // A product card links its image and its title under the same accessible name. "The
    // product link is visible" is true of either; an assertion that trips strict mode is not
    // what the planner meant, and it used to fail every run at the same step.
    const page = await kit.newPage();
    await page.setContent('<a href="#" id="img"><img alt="Sauce Labs Backpack"></a><a href="#" id="title">Sauce Labs Backpack</a>');
    const r = await kit.checkExpectation(page, { type: "visible", role: "link", name: "Sauce Labs Backpack" }, page.url());
    expect(r.ok).toBe(true);
    expect(r.code).toBe("await expect(page.getByRole('link', { name: 'Sauce Labs Backpack' }).first()).toBeVisible();");
    await page.close();
  });
});

describe("BrowserToolkit goto with a pathed base URL", () => {
  it("resolves site-map routes against the origin, not the entry page's path", async () => {
    // The target URL a user enters is often the login page itself ("https://app/sso/login").
    // Routes in the site map are origin-absolute ("/products"), so a goto must not glue them
    // onto the entry path into "/sso/login/products".
    const pathed = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base + "/login" });
    try {
      const page = await pathed.newPage();
      await pathed.act(page, { action: "goto", target: "/products" });
      expect(new URL(page.url()).pathname).toBe("/products");
      await pathed.act(page, { action: "goto", target: "/" });
      expect(new URL(page.url()).pathname).toBe("/");
      await page.close();
    } finally {
      await pathed.close();
    }
  });
});
