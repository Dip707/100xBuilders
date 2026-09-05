import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startRootLogin } from "./helpers/rootlogin.js";
import { startShop } from "./helpers/shop.js";
import { crawl } from "../src/nodes/explore.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";

let app: Awaited<ReturnType<typeof startRootLogin>>;
let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { [app, shop] = await Promise.all([startRootLogin(), startShop()]); });
afterAll(async () => { await Promise.all([app.stop(), shop.stop()]); });

describe("login discovery", () => {
  it("signs in when the landing page is itself the login page", async () => {
    // Before the fix, login discovery only searched for a *link* matching /login/. An app
    // with its form at "/" has no such link, so the crawler never signed in, saw exactly
    // one page, and reported success having silently ignored the credentials it was given.
    // saucedemo.com has precisely this shape, and so do most internal tools.
    const kit = await BrowserToolkit.launch({ baseUrl: app.base, headless: true });
    try {
      const map = await crawl(kit, { credentials: { username: "demo", password: "secret" }, maxPages: 30 });
      expect(map.loginPath).toBe("/");
      expect(map.loginSteps.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(map.pages)).toEqual(expect.arrayContaining(["/inventory", "/cart", "/account"]));
      expect(Object.keys(map.pages).length).toBeGreaterThan(1);
    } finally {
      await kit.close();
    }
  }, 90_000);

  it("still follows a link to a separate login page", async () => {
    // The original strategy has to keep working: mini-shop links to /login from its home
    // page, and that path must not regress now that the form check runs first.
    const kit = await BrowserToolkit.launch({ baseUrl: shop.base, headless: true });
    try {
      const map = await crawl(kit, { credentials: { username: "demo@shop.test", password: "demo1234" }, maxPages: 30 });
      expect(map.loginPath).toBe("/login");
      expect(map.loginSteps.length).toBeGreaterThanOrEqual(3);
    } finally {
      await kit.close();
    }
  }, 90_000);
});
