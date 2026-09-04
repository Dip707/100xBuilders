import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { startRun } from "../src/run.js";
import { FakeLlmClient } from "../src/llm/client.js";
import type { Flow } from "../src/state.js";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { await shop.stop(); });

const flows: Flow[] = [
  { id: "auth-001", title: "Login with valid credentials lands on products", category: "happy", priority: "P0", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "email" }, { action: "fill", role: "textbox", name: "Password", value: "demo1234", intent: "password" }, { action: "click", role: "button", name: "Sign in", intent: "submit" }],
    expected: [{ type: "url_contains", value: "/products" }, { type: "visible", role: "heading", name: "Products" }] },
  { id: "auth-002", title: "Login with wrong password shows error", category: "negative", priority: "P1", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "email" }, { action: "fill", role: "textbox", name: "Password", value: "wrong", intent: "password" }, { action: "click", role: "button", name: "Sign in", intent: "submit" }],
    expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }, { type: "url_stays", value: "/login" }] },
  { id: "auth-003", title: "Login with empty form shows validation", category: "negative", priority: "P2", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "click", role: "button", name: "Sign in", intent: "submit empty" }],
    expected: [{ type: "url_stays", value: "/login" }] },
  { id: "orders-authz-001", title: "Orders redirects to login when logged out", category: "authz", priority: "P1", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/orders", intent: "open orders" }], expected: [{ type: "url_contains", value: "/login" }] },
  { id: "checkout-001", title: "Apply valid coupon shows applied status", category: "happy", priority: "P1", preconditions: ["logged_in"], source: "intent",
    steps: [{ action: "goto", target: "/checkout", intent: "open checkout" }, { action: "fill", role: "textbox", name: "Coupon code", value: "SAVE10", intent: "enter coupon" }, { action: "click", role: "button", name: "Apply coupon", intent: "apply coupon" }],
    expected: [{ type: "visible", role: "status", text_contains: "Coupon applied" }] },
];

describe("full graph against mini-shop with the fake LLM", () => {
  it("produces every output file and escalates the broken coupon endpoint", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-graph-")) + "/";
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    const llm = new FakeLlmClient({
      plan: { flows },
      "classify-rationale": { rationale: "Server returned 500 on the coupon endpoint.", confidence_adjustment: 0 },
      heal: { role: "button", name: "Apply coupon", reason: "unchanged", confidence: 0.2 },
    });
    const { runId, done } = startRun({ runId: "it-1", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" }, intent: "login and checkout coupon", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } }, { headless: true, llm });
    const final = await done;
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
    const dir = process.env.QA_PILOT_OUTPUT + runId + "/";
    for (const f of ["plan.md", "plan.json", "coverage.json", "results.json", "heal-log.json", "defects.json", "report.md", "report.html", "decisions.jsonl", "events.jsonl"]) expect(existsSync(dir + f), f).toBe(true);
    expect(existsSync(dir + "tests/auth-002.spec.ts")).toBe(true);
    const passed = final.results!.tests.filter((t) => t.status === "passed").map((t) => t.id);
    expect(passed).toEqual(expect.arrayContaining(["auth-001", "auth-002", "auth-003", "orders-authz-001"]));
    const coupon = final.classifications.find((c) => c.test === "checkout-001");
    expect(coupon?.class).toBe("defect");
    expect(coupon?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(final.defects.map((d) => d.flow)).toContain("checkout-001");
    const decisions = readFileSync(dir + "decisions.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.node)).toEqual(expect.arrayContaining(["explore", "evaluate_coverage", "classify"]));
  }, 300_000);
});
