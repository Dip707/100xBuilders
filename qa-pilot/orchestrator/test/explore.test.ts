import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { exploreNode } from "../src/nodes/explore.js";
import { initialState } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

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
});
