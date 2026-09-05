import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startShop } from "./helpers/shop.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { AgentDecisionSchema, buildAgentInput, exploreWithAgent, materialize, redact, PASSWORD_TOKEN, USERNAME_TOKEN } from "../src/nodes/explore-agent.js";
import type { SiteMap } from "../src/state.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const creds = { username: "demo@shop.test", password: "demo1234" };

describe("materialize", () => {
  it("substitutes the credential tokens and leaves other values alone", () => {
    expect(materialize({ action: "fill", role: "textbox", name: "Email", value: USERNAME_TOKEN }, creds).value).toBe("demo@shop.test");
    expect(materialize({ action: "fill", role: "textbox", name: "Password", value: PASSWORD_TOKEN }, creds).value).toBe("demo1234");
    expect(materialize({ action: "fill", role: "textbox", name: "Search", value: "shoes" }, creds).value).toBe("shoes");
  });
  it("refuses a token when no credentials exist", () => {
    expect(() => materialize({ action: "fill", role: "textbox", name: "Password", value: PASSWORD_TOKEN })).toThrow(/no credentials/);
  });
});

describe("redact", () => {
  it("replaces filled credential values with the tokens", () => {
    expect(redact('- textbox "Password": demo1234\n- text: demo@shop.test', creds)).toBe('- textbox "Password": {{PASSWORD}}\n- text: {{USERNAME}}');
  });
});

describe("AgentDecisionSchema", () => {
  it("rejects an action with neither role nor name", () => {
    expect(AgentDecisionSchema.safeParse({ reasoning: "x", done: false, action: { action: "click" } }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ reasoning: "x", done: true }).success).toBe(true);
  });
});

describe("buildAgentInput", () => {
  it("never carries the password and truncates a huge snapshot", () => {
    const siteMap: SiteMap = { origin: "http://x", loginPath: "/login", loginSteps: [], pages: {} };
    const input = buildAgentInput({ url: "http://x/", hasCredentials: true, siteMap, history: [], snapshot: "a".repeat(20000) });
    expect(input).toContain("Credentials available: yes");
    expect(input).toContain("(truncated)");
    expect(input.length).toBeLessThan(9000);
  });
});

describe("exploreWithAgent against mini-shop", () => {
  let shop: Awaited<ReturnType<typeof startShop>>;
  beforeAll(async () => { shop = await startShop(); });
  afterAll(async () => { await shop.stop(); });

  it("signs in with tokens, records login steps, adds discovered pages, refuses destructive clicks, and stops when done", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base });
    const dir = mkdtempSync(join(tmpdir(), "qa-agent-")) + "/";
    const bus = new EventBus("r", dir);
    const logs: string[] = [];
    bus.subscribe((e) => { if (e.type === "agent_log") logs.push(e.message ?? ""); });
    const script = [
      { reasoning: "open the login page", done: false, action: { action: "goto", target: "/login" } },
      { reasoning: "enter username", done: false, action: { action: "fill", role: "textbox", name: "Email", value: USERNAME_TOKEN } },
      { reasoning: "enter password", done: false, action: { action: "fill", role: "textbox", name: "Password", value: PASSWORD_TOKEN } },
      { reasoning: "submit", done: false, action: { action: "click", role: "button", name: "Sign in" } },
      { reasoning: "try to log out", done: false, action: { action: "click", role: "button", name: "Log out" } },
      { reasoning: "open orders", done: false, action: { action: "goto", target: "/orders" } },
      { reasoning: "nothing new left", done: true },
    ];
    let n = 0;
    const inputs: string[] = [];
    const llm = new FakeLlmClient({ "explore-agent": (input: string) => { inputs.push(input); return script[Math.min(n++, script.length - 1)]; } });
    const siteMap: SiteMap = { origin: new URL(shop.base).origin, loginPath: "/login", loginSteps: [], pages: {} };
    try {
      const r = await exploreWithAgent(kit, siteMap, { llm, bus, credentials: creds, maxSteps: 10 });
      expect(r.steps).toBe(6);
      expect(r.discovered).toEqual(expect.arrayContaining(["/login", "/orders"]));
      expect(siteMap.loginSteps.map((s) => s.action)).toEqual(["goto", "fill", "fill", "click"]);
      expect(siteMap.loginSteps[2].value).toBe("demo1234");
      expect(siteMap.pages["/orders"].gated).toBe(true);
      expect(logs.some((m) => /agent signed in via \/login/.test(m))).toBe(true);
      expect(logs.some((m) => /agent refused: .*Log out/.test(m))).toBe(true);
      // The model never sees the password, in the prompt or in the action history.
      expect(inputs.join("\n")).not.toContain("demo1234");
    } finally {
      await kit.close();
    }
  });
});
