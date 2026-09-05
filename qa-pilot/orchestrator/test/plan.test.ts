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
import { driftedFields } from "../src/nodes/plan.js";

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
    expect(update.unresolvedFlows).toEqual(["auth-999"]);
    expect(update.planIterations).toBe(1);
    expect(update.llmCalls).toBe(2);
    expect(existsSync(process.env.QA_PILOT_OUTPUT + "r/plan.json")).toBe(true);
    expect(readFileSync(process.env.QA_PILOT_OUTPUT + "r/plan.md", "utf8")).toContain("auth-002");
  });
});

describe("renderPlanMd", () => {
  it("groups by category", () => {
    const md = renderPlanMd([good]);
    expect(md).toContain("## negative");
    expect(md).toContain("Login with wrong password shows error");
  });
});

describe("driftedFields", () => {
  it("ignores a steps-only repair and names every other field a repair moved", () => {
    expect(driftedFields(good, { ...good, steps: [{ action: "goto", target: "/x" }] })).toEqual([]);
    expect(driftedFields(good, { ...good, expected: [{ type: "visible", role: "alert", text_contains: "Welcome" }] })).toEqual(["expected"]);
    expect(driftedFields(good, { ...good, id: "auth-000", title: "Something else", expected: [] })).toEqual(["id", "title", "expected"]);
  });
});

describe("planNode repair guard", () => {
  it("takes only the repaired steps and discards a repair's attempt to rewrite the expectations", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-plan-guard-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    // A repair that fixes the unresolvable step (Teleport -> Sign in) but also swaps the
    // expectation for one the page will never satisfy. Unguarded, that assertion reaches the
    // runner, fails, and is reported as an application defect that does not exist.
    const llm = new FakeLlmClient({
      plan: { flows: [hallucinated] },
      "plan-repair": () => ({
        ...hallucinated,
        title: "Rewritten by the repair",
        expected: [{ type: "visible", role: "alert", text_contains: "Fabricated defect" }],
        steps: [
          { action: "goto", target: "/login", intent: "open login" },
          { action: "click", role: "button", name: "Sign in", intent: "submit" },
        ],
      }),
    });
    const state = { ...initialState({ runId: "r", url: shop.base }), siteMap };
    const update = await planNode(state, { bus, llm, headless: true });

    const kept = (update.plan as Flow[]).find((f) => f.id === "auth-999");
    expect(kept).toBeDefined();
    // the repair's steps were taken...
    expect(kept!.steps.map((x) => x.name)).toContain("Sign in");
    // ...and nothing else was.
    expect(kept!.expected).toEqual(hallucinated.expected);
    expect(kept!.title).toBe(hallucinated.title);
    expect(JSON.stringify(kept)).not.toContain("Fabricated defect");

    const drift = bus.replay().filter((e) => e.type === "decision" && (e.message ?? "").includes("plan-repair also rewrote"));
    expect(drift).toHaveLength(1);
    expect(drift[0].message ?? "").toContain("title");
    expect(drift[0].message ?? "").toContain("expected");
  });
});
