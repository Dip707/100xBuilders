import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { exploreNode, crawl, filterLinks } from "../src/nodes/explore.js";
import { initialState } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { await shop.stop(); });

describe("exploreNode", () => {
  it("crawls mini-shop, records forms, and detects gated routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-explore-")) + "/";
    const bus = new EventBus("r", dir);
    const state = initialState({ runId: "r", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" } });
    const update = await exploreNode(state, { bus, llm: new FakeLlmClient({}), headless: true });
    const map = update.siteMap!;
    expect(Object.keys(map.pages)).toEqual(expect.arrayContaining(["/", "/login", "/register", "/products", "/cart", "/orders", "/account", "/checkout"]));
    expect(map.pages["/orders"].gated).toBe(true);
    expect(map.pages["/products"].gated).toBe(false);
    expect(map.pages["/login"].forms[0].fields.map((f) => f.name)).toEqual(["Email", "Password"]);
    expect(map.pages["/login"].forms[0].submit).toEqual({ role: "button", name: "Sign in" });
    expect(map.loginPath).toBe("/login");
    expect(map.loginSteps.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(map.pages).length).toBeLessThanOrEqual(30);
  });

  it("crawl() keeps pages bounded to maxPages even with the pre-login seed and redirects", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base });
    try {
      const map = await crawl(kit, {
        credentials: { username: "demo@shop.test", password: "demo1234" },
        maxPages: 3,
      });
      expect(Object.keys(map.pages).length).toBeLessThanOrEqual(3);
    } finally {
      await kit.close();
    }
  });
});

describe("filterLinks", () => {
  it("keeps only same-origin links that aren't blocklisted or logout links", () => {
    const origin = "https://example.test";
    const links = [
      { href: "https://external.test/products", text: "External" },
      { href: "https://example.test/account", text: "Log out" },
      { href: "https://example.test/logout", text: "Bye" },
      { href: "https://example.test/products", text: "Products" },
    ];
    expect(filterLinks(links, origin)).toEqual(["/products"]);
  });
});

describe("crawl on a single-page app", () => {
  it("finds JS-rendered links, pushState navigation and hash routes without clicking destructive controls", async () => {
    const { startSpa } = await import("./helpers/spa.js");
    const spa = await startSpa();
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: spa.base });
    try {
      const map = await crawl(kit, {});
      expect(Object.keys(map.pages)).toEqual(expect.arrayContaining(["/", "/about", "/contact", "/#/faq"]));
      expect(map.pages["/contact"].forms).toHaveLength(1);
      expect(spa.destroyed()).toBe(0);
    } finally {
      await kit.close();
      await spa.stop();
    }
  }, 120_000);
});

describe("crawl behind a login wall", () => {
  it("logs in from a landing page that is itself the login form, then explores what is behind it", async () => {
    const { startKiosk } = await import("./helpers/kiosk.js");
    const kiosk = await startKiosk();
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: kiosk.base });
    try {
      const map = await crawl(kit, { credentials: { username: "shopper", password: "hunter2" } });
      expect(map.loginPath).toBe("/");
      expect(map.loginSteps.length).toBeGreaterThanOrEqual(4);
      // Behind the wall: an anchor with no href, an anchor with href="#", and submit-styled
      // buttons that sit outside any form are all the app gives the crawler to navigate with.
      expect(Object.keys(map.pages)).toEqual(expect.arrayContaining(["/", "/catalog.html", "/basket.html", "/item.html", "/pay.html"]));
      expect(map.pages["/pay.html"].forms).toHaveLength(1);
      // These routes answer an anonymous visitor with the login screen at the same URL.
      expect(map.pages["/catalog.html"].gated).toBe(true);
      expect(map.pages["/basket.html"].gated).toBe(true);
      expect(map.pages["/"].gated).toBe(false);
    } finally {
      await kit.close();
      await kiosk.stop();
    }
  }, 180_000);
});

describe("BLOCKLIST", () => {
  it("covers the controls that throw app state away, not just the ones that delete a row", async () => {
    const { BLOCKLIST } = await import("../src/nodes/deps.js");
    for (const label of ["Delete", "Remove item", "Log out", "Sign out", "Clear data", "Reset App State", "Wipe database", "Erase history", "Revoke token", "Cancel subscription"]) {
      expect(BLOCKLIST.test(label), label).toBe(true);
    }
    // "Reset" is blocked wholesale, "Reset filters" included: a reset control is never the way
    // to a new route, so skipping a harmless one costs the crawl nothing while clicking a
    // destructive one mid-crawl invalidates every probe after it.
    expect(BLOCKLIST.test("Reset filters")).toBe(true);
    // Ordinary navigation and form controls stay clickable.
    for (const label of ["Checkout", "Continue Shopping", "Back to products", "Add to cart", "Cancel"]) {
      expect(BLOCKLIST.test(label), label).toBe(false);
    }
  });
});
