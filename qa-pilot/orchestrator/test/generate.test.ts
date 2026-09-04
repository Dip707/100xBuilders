import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { crawl } from "../src/nodes/explore.js";
import { generateFlowNode } from "../src/nodes/generate.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { initialState, type Flow, type SiteMap } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

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
  id: "orders-authz-001", title: "Orders page redirects to login when logged out", category: "authz", priority: "P1",
  preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: "/orders", intent: "open orders while logged out" }],
  expected: [{ type: "url_contains", value: "/login" }, { type: "visible", role: "heading", name: "Log in" }],
};
const loggedIn: Flow = {
  id: "checkout-empty-001", title: "Checkout with a short card number stays on checkout", category: "negative", priority: "P1",
  preconditions: ["logged_in"], source: "explored",
  steps: [
    { action: "goto", target: "/checkout", intent: "open checkout" },
    { action: "fill", role: "textbox", name: "Full name", value: "A", intent: "enter name" },
    { action: "fill", role: "textbox", name: "Address", value: "B", intent: "enter address" },
    { action: "fill", role: "textbox", name: "Card number", value: "123", intent: "enter short card" },
    { action: "click", role: "button", name: "Place order", intent: "submit order" },
  ],
  expected: [{ type: "url_stays", value: "/checkout" }],
};

describe("generateFlowNode", () => {
  it("writes a passing spec for a logged-out flow", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-gen-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: flow };
    const update = await generateFlowNode(state, { bus, llm: new FakeLlmClient({}), headless: true });
    expect(update.testFiles).toHaveLength(1);
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page).toHaveURL(/\\/login/);");
    expect(src).toContain("page.getByRole('heading', { name: 'Log in' })");
  }, 120_000);

  it("handles logged_in preconditions", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-gen2-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: loggedIn };
    const update = await generateFlowNode(state, { bus, llm: new FakeLlmClient({}), headless: true });
    expect(update.testFiles).toHaveLength(1);
    expect(readFileSync((update.testFiles as string[])[0], "utf8")).toContain("await login();");
  }, 120_000);

  it("reports unresolved when a step element is missing", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-gen3-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const bad: Flow = { ...flow, id: "bad-001", steps: [{ action: "goto", target: "/login" }, { action: "click", role: "button", name: "Teleport" }] };
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: bad };
    const update = await generateFlowNode(state, { bus, llm: new FakeLlmClient({}), headless: true });
    expect(update.unresolvedFlows).toEqual(["bad-001"]);
  });
});
