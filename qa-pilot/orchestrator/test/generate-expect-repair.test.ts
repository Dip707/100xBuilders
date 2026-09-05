import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { generateFlowNode } from "../src/nodes/generate.js";
import { initialState, type Flow, type RunResults, type SiteMap } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { runPlaywright } from "../src/nodes/run.js";

// The runner is stubbed so only the live validation against mini-shop is exercised.
vi.mock("../src/nodes/run.js", () => ({ runPlaywright: vi.fn() }));
const runPlaywrightMock = vi.mocked(runPlaywright);

let shop: Awaited<ReturnType<typeof startShop>>;
const siteMap: SiteMap = { origin: "", loginPath: "/login", loginSteps: [], pages: {} };
beforeAll(async () => {
  shop = await startShop();
  siteMap.origin = shop.base;
});
afterAll(async () => { await shop.stop(); });
beforeEach(() => { runPlaywrightMock.mockReset(); });

// The planner named the heading wrong: the live page says "Welcome back".
const flow: Flow = {
  id: "auth-heading-001", title: "Login page shows its heading", category: "happy", priority: "P2", preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: "/login", intent: "open the login page" }],
  expected: [{ type: "url_contains", value: "/login" }, { type: "visible", role: "heading", name: "Sign in to your account" }],
};
const passed = (): RunResults => ({ tests: [{ id: flow.id, file: "x", title: flow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "" });

function fresh(prefix: string) {
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), prefix)) + "/";
  const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
  const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: flow };
  return { bus, state };
}

describe("generateFlowNode expectation repair", () => {
  it("re-targets an expectation that is false live to the element the LLM picks, once verified", async () => {
    const { bus, state } = fresh("qa-exp-repair-a-");
    runPlaywrightMock.mockResolvedValueOnce(passed());
    const llm = new FakeLlmClient({ "expect-repair": { role: "heading", name: "Welcome back", reason: "the login page heading is titled Welcome back", confidence: 0.9 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();");
    expect(src).not.toContain("Sign in to your account");
    expect(update.llmCalls).toBe(state.llmCalls + 1);
    expect(bus.replay().some((e) => e.type === "decision" && String(e.message).includes("re-targeted expectation"))).toBe(true);
  }, 120_000);

  it("keeps the original expectation when the LLM finds nothing, so the runner can surface a defect", async () => {
    const { bus, state } = fresh("qa-exp-repair-b-");
    runPlaywrightMock.mockResolvedValueOnce(passed());
    const llm = new FakeLlmClient({ "expect-repair": { role: "heading", name: "", reason: "no heading resembles it", confidence: 0 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();");
  }, 120_000);

  it("rejects a repair that changes the role or the asserted text", async () => {
    const { bus, state } = fresh("qa-exp-repair-c-");
    runPlaywrightMock.mockResolvedValueOnce(passed());
    const llm = new FakeLlmClient({ "expect-repair": { role: "link", name: "Log in", reason: "there is a Log in link", confidence: 0.9 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();");
    expect(src).not.toContain("getByRole('link'");
  }, 120_000);
});

// The planner guessed the post-login URL; the app really lands on /products.
const urlFlow: Flow = {
  id: "auth-url-001", title: "Login lands on the dashboard", category: "happy", priority: "P1", preconditions: ["logged_out"], source: "explored",
  steps: [
    { action: "goto", target: "/login" },
    { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test" },
    { action: "fill", role: "textbox", name: "Password", value: "demo1234" },
    { action: "click", role: "button", name: "Sign in" },
  ],
  expected: [{ type: "url_contains", value: "/dashboard" }],
};

describe("generateFlowNode URL expectation repair", () => {
  function freshUrl(prefix: string) {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), prefix)) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: urlFlow };
    return { bus, state };
  }
  it("replaces a URL fragment the app never reaches with the one the LLM proposes, once verified against the live URL", async () => {
    const { bus, state } = freshUrl("qa-url-repair-a-");
    runPlaywrightMock.mockResolvedValueOnce({ tests: [{ id: urlFlow.id, file: "x", title: urlFlow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "" });
    const llm = new FakeLlmClient({ "expect-repair": { role: "", name: "", value: "/products", reason: "a successful login lands on the product list", confidence: 0.9 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page).toHaveURL(/\\/products/);");
    expect(src).not.toContain("/dashboard");
  }, 120_000);
  it("keeps the original URL expectation when the proposal is trivial or not where the app landed", async () => {
    for (const value of ["/", "/orders"]) {
      const { bus, state } = freshUrl("qa-url-repair-b-");
      runPlaywrightMock.mockResolvedValueOnce({ tests: [{ id: urlFlow.id, file: "x", title: urlFlow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "" });
      const llm = new FakeLlmClient({ "expect-repair": { role: "", name: "", value, reason: "guess", confidence: 0.9 } });
      const update = await generateFlowNode(state, { bus, llm, headless: true });
      expect(readFileSync((update.testFiles as string[])[0], "utf8")).toContain("await expect(page).toHaveURL(/\\/dashboard/);");
    }
  }, 120_000);
});

// The planner expected a status message; the app shows the same text in an alert.
const textFlow: Flow = {
  id: "auth-text-001", title: "Wrong password shows an error", category: "negative", priority: "P1", preconditions: ["logged_out"], source: "explored",
  steps: [
    { action: "goto", target: "/login" },
    { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test" },
    { action: "fill", role: "textbox", name: "Password", value: "wrong" },
    { action: "click", role: "button", name: "Sign in" },
  ],
  expected: [{ type: "visible", role: "status", text_contains: "Invalid" }],
};

describe("generateFlowNode re-target across roles when the asserted text is kept", () => {
  it("moves a text expectation to the element that really carries the text", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-text-repair-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: textFlow };
    runPlaywrightMock.mockResolvedValueOnce({ tests: [{ id: textFlow.id, file: "x", title: textFlow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "" });
    const llm = new FakeLlmClient({ "expect-repair": { role: "alert", name: "", reason: "the error is rendered as an alert", confidence: 0.9 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await expect(page.getByRole('alert')).toContainText('Invalid');");
    expect(src).not.toContain("'status'");
  }, 120_000);
});

describe("generateFlowNode records re-targeted expectations", () => {
  it("returns the effective expectation list so later nodes verify what the spec asserts", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-exp-state-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: urlFlow };
    runPlaywrightMock.mockResolvedValueOnce({ tests: [{ id: urlFlow.id, file: "x", title: urlFlow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }], at: "" });
    const llm = new FakeLlmClient({ "expect-repair": { role: "", name: "", value: "/products", reason: "login lands on the product list", confidence: 0.9 } });
    const update = await generateFlowNode(state, { bus, llm, headless: true });
    expect(update.expectations).toEqual({ [urlFlow.id]: [{ type: "url_contains", value: "/products" }] });
  }, 120_000);
  it("records nothing when every expectation held as planned", async () => {
    const { bus, state } = fresh("qa-exp-state-b-");
    runPlaywrightMock.mockResolvedValueOnce(passed());
    const held = { ...state, currentFlow: { ...flow, expected: [{ type: "url_contains" as const, value: "/login" }] } };
    const update = await generateFlowNode(held, { bus, llm: new FakeLlmClient({}), headless: true });
    expect(update.expectations).toBeUndefined();
  }, 120_000);
});
