import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreCoverage, coverageNode, afterCoverage, COVERAGE_THRESHOLD, MAX_PLAN_ITERATIONS } from "../src/nodes/coverage.js";
import { initialState, type CoverageVerdict, type Flow, type SiteMap } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

const siteMap: SiteMap = {
  origin: "http://x", loginPath: "/login", loginSteps: [],
  pages: {
    "/login": { url: "http://x/login", path: "/login", title: "Log in", gated: false, snapshot: "", buttons: [], links: [],
      forms: [{ id: "/login#0", submit: { role: "button", name: "Sign in" }, fields: [{ role: "textbox", name: "Email", type: "email", required: true }, { role: "textbox", name: "Password", type: "password", required: true }] }] },
    "/orders": { url: "http://x/orders", path: "/orders", title: "Orders", gated: true, snapshot: "", buttons: [], links: [], forms: [] },
  },
};
const mk = (id: string, category: Flow["category"], title: string, path = "/login"): Flow => ({
  id, title, category, priority: "P1", preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: path }], expected: [{ type: "url_stays", value: path }],
});

describe("scoreCoverage", () => {
  it("scores a plan with only a happy flow low and lists the gaps", () => {
    const v = scoreCoverage(siteMap, [mk("a1", "happy", "Login works")], {});
    expect(v.score).toBeLessThan(0.75);
    expect(v.gaps.map((g) => g.kind)).toEqual(expect.arrayContaining(["missing_negative", "missing_empty_submit", "missing_authz", "category_mix"]));
  });
  it("scores a complete plan above threshold", () => {
    const flows = [
      mk("a1", "happy", "Login works"),
      mk("a2", "negative", "Login wrong password"),
      mk("a3", "negative", "Login empty submit shows validation"),
      mk("o1", "authz", "Orders redirects when logged out", "/orders"),
      mk("e1", "edge", "Login with very long email"),
    ];
    const v = scoreCoverage(siteMap, flows, { intent: "login and orders" });
    expect(v.score).toBeGreaterThanOrEqual(0.75);
    expect(v.gaps).toHaveLength(0);
  });
  it("counts PRD coverage from the matrix", () => {
    const flows = [mk("a1", "happy", "Login works")];
    const v = scoreCoverage(siteMap, flows, { prdRequirements: ["R1 login", "R2 reset password"], prdMatrix: { "R1 login": ["a1"], "R2 reset password": [] } });
    expect(v.checks.prd).toBe(0.5);
    expect(v.gaps.find((g) => g.kind === "prd_uncovered")?.requirement).toBe("R2 reset password");
  });
});

describe("coverageNode", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "qa-coverage-")) + "/";
    process.env.QA_PILOT_OUTPUT = outDir;
  });

  it("scores the plan without a PRD and makes no LLM calls", async () => {
    const bus = new EventBus("r", outDir + "r/");
    const llm = new FakeLlmClient({});
    const state = { ...initialState({ runId: "r", url: "http://x" }), siteMap, plan: [mk("a1", "happy", "Login works")], planIterations: 1 };
    const update = await coverageNode(state, { bus, llm, headless: true });
    expect(update.llmCalls).toBe(state.llmCalls);
    expect((update.coverage as CoverageVerdict).score).toBeLessThan(0.75);
    const history = JSON.parse(readFileSync(outDir + "r/coverage.json", "utf8"));
    expect(history).toHaveLength(1);
    expect(history[0].iteration).toBe(1);
  });

  it("extracts PRD requirements, builds the matrix via the LLM, and appends to coverage.json across iterations", async () => {
    const bus = new EventBus("r", outDir + "r/");
    const llm = new FakeLlmClient({
      "prd-requirements": { requirements: ["R1 login"] },
      "prd-matrix": { matrix: [{ requirement: "R1 login", flow_ids: ["a1"] }] },
    });
    const flows = [mk("a1", "happy", "Login works")];
    const state = { ...initialState({ runId: "r", url: "http://x", prdText: "users can log in" }), siteMap, plan: flows, planIterations: 0 };
    const first = await coverageNode(state, { bus, llm, headless: true });
    expect(first.llmCalls).toBe(2);
    expect((first.coverage as CoverageVerdict).checks.prd).toBe(1);

    const state2 = { ...state, coverage: first.coverage as CoverageVerdict, llmCalls: first.llmCalls as number, planIterations: 1 };
    await coverageNode(state2, { bus, llm, headless: true });
    const history = JSON.parse(readFileSync(outDir + "r/coverage.json", "utf8"));
    expect(history.map((h: { iteration: number }) => h.iteration)).toEqual([0, 1]);
  });
});

describe("afterCoverage", () => {
  it("returns generate and records a decision when score meets the threshold", () => {
    const bus = new EventBus("r", mkdtempSync(join(tmpdir(), "qa-coverage-")) + "/r/");
    const state = { ...initialState({ runId: "r", url: "http://x" }), coverage: { score: COVERAGE_THRESHOLD, gaps: [], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} } as CoverageVerdict };
    expect(afterCoverage(state, { bus, llm: new FakeLlmClient({}), headless: true })).toBe("generate");
  });
  it("returns generate once the max plan iterations are reached even if score is low", () => {
    const bus = new EventBus("r", mkdtempSync(join(tmpdir(), "qa-coverage-")) + "/r/");
    const state = { ...initialState({ runId: "r", url: "http://x" }), planIterations: MAX_PLAN_ITERATIONS, coverage: { score: 0.1, gaps: [], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} } as CoverageVerdict };
    expect(afterCoverage(state, { bus, llm: new FakeLlmClient({}), headless: true })).toBe("generate");
  });
  it("returns plan and records a decision when score is below threshold and iterations remain", () => {
    const outDir = mkdtempSync(join(tmpdir(), "qa-coverage-")) + "/";
    const bus = new EventBus("r", outDir + "r/");
    const state = { ...initialState({ runId: "r", url: "http://x" }), planIterations: 1, coverage: { score: 0.1, gaps: [{ kind: "missing_authz", target: "/orders", suggest: "add authz flow" }], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} } as CoverageVerdict };
    expect(afterCoverage(state, { bus, llm: new FakeLlmClient({}), headless: true })).toBe("plan");
    const decisions = readFileSync(outDir + "r/decisions.jsonl", "utf8");
    expect(decisions).toContain("missing_authz");
  });
});
