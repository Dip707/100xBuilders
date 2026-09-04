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
