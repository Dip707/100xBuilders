import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { crawl } from "../src/nodes/explore.js";
import { planNode, renderPlanMd } from "../src/nodes/plan.js";
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

const good: Flow = {
  id: "auth-002", title: "Login with wrong password shows error", category: "negative", priority: "P1",
  preconditions: ["logged_out"], source: "explored",
  steps: [
    { action: "goto", target: "/login", intent: "open login" },
    { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "enter email" },
    { action: "fill", role: "textbox", name: "Password", value: "wrong", intent: "enter password" },
    { action: "click", role: "button", name: "Sign in", intent: "submit" },
  ],
  expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }, { type: "url_stays", value: "/login" }],
};
const hallucinated: Flow = { ...good, id: "auth-999", title: "Uses a button that does not exist", steps: [{ action: "goto", target: "/login" }, { action: "click", role: "button", name: "Teleport" }] };

describe("planNode", () => {
  it("keeps flows that dry-walk, drops hallucinated ones after one repair, writes plan files", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-plan-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const llm = new FakeLlmClient({
      plan: { flows: [good, hallucinated] },
      "plan-repair": (input: string) => ({ ...JSON.parse(input.split("FLOW:\n")[1].split("\nFAILING_STEP")[0]), steps: [] }),
    });
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap };
    const update = await planNode(state, { bus, llm, headless: true });
    expect((update.plan as Flow[]).map((f) => f.id)).toEqual(["auth-002"]);
    // The routes the dry walk saw the flow on, which is what the coverage scorer credits.
    expect((update.plan as Flow[])[0].visits).toEqual(["/login"]);
    expect(update.unresolvedFlows).toEqual(["auth-999"]);
    expect(update.planIterations).toBe(1);
    expect(update.llmCalls).toBe(2);
    expect(existsSync(process.env.QA_PILOT_OUTPUT + "r/plan.json")).toBe(true);
    expect(readFileSync(process.env.QA_PILOT_OUTPUT + "r/plan.md", "utf8")).toContain("auth-002");
  });
});

describe("planNode when a dry walk throws", () => {
  it("drops that flow with the error on record and keeps the rest, instead of failing the run", async () => {
    // A page that cannot be loaded at all: the browser throws rather than reporting an
    // unresolved element. One such flow used to take the whole plan node, and the run, down.
    const unreachable: Flow = { ...good, id: "cart-001", title: "Opens a page that never loads", steps: [{ action: "goto", target: "http://127.0.0.1:1/" }] };
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-plan-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const decisions: string[] = [];
    bus.subscribe((e) => { if (e.type === "decision") decisions.push(e.message ?? ""); });
    const llm = new FakeLlmClient({ plan: { flows: [unreachable, good] } });
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap };
    const update = await planNode(state, { bus, llm, headless: true });
    expect((update.plan as Flow[]).map((f) => f.id)).toEqual(["auth-002"]);
    expect(update.unresolvedFlows).toEqual(["cart-001"]);
    expect(decisions.find((d) => d.includes("cart-001"))).toMatch(/ECONNREFUSED|net::ERR|page\.goto/);
  });
});

describe("renderPlanMd", () => {
  it("groups by category", () => {
    const md = renderPlanMd([good]);
    expect(md).toContain("## negative");
    expect(md).toContain("Login with wrong password shows error");
  });
});

describe("buildPlanInput", () => {
  it("collapses a control repeated across a list into one entry with its count", async () => {
    const { buildPlanInput } = await import("../src/nodes/plan.js");
    const map: SiteMap = {
      origin: "http://x", loginPath: null, loginSteps: [],
      pages: {
        "/inventory": {
          url: "http://x/inventory", path: "/inventory", title: "Products", forms: [], gated: true, snapshot: "",
          buttons: [{ role: "button", name: "Open Menu" }, ...Array.from({ length: 6 }, () => ({ role: "button", name: "Add to cart" }))],
          links: [],
        },
      },
    };
    const input = buildPlanInput({ ...initialState({ runId: "r", userId: "u", url: "http://x" } as never), siteMap: map, plan: [], maxFlows: 12 } as never);
    expect(input).toContain('buttons: "Open Menu", "Add to cart" (x6)');
    expect(input.match(/Add to cart/g)?.length).toBe(1);
  });
});

describe("StepSchema", () => {
  it("rejects a non-goto step that names no element", async () => {
    const { StepSchema } = await import("../src/state.js");
    expect(StepSchema.safeParse({ action: "click", intent: "open the cart" }).success).toBe(false);
    expect(StepSchema.safeParse({ action: "click", name: "shopping-cart-link" }).success).toBe(true);
    expect(StepSchema.safeParse({ action: "goto", target: "/cart" }).success).toBe(true);
  });
});

describe("the model-facing plan schema", () => {
  it("does not ask the model for the routes a flow visits; the dry walk records those", async () => {
    const { PlanOutputSchema, RepairedFlowSchema } = await import("../src/nodes/plan.js");
    expect(Object.keys(PlanOutputSchema.shape.flows.element.shape)).not.toContain("visits");
    expect(Object.keys(RepairedFlowSchema.shape)).not.toContain("visits");
  });
});
