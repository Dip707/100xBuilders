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

  it("tolerates an LLM failure on prd-requirements and still resolves with a scored verdict", async () => {
    const bus = new EventBus("r", outDir + "r/");
    const llm = new FakeLlmClient({
      "prd-requirements": () => {
        throw new Error("boom");
      },
    });
    const flows = [mk("a1", "happy", "Login works")];
    const state = { ...initialState({ runId: "r", url: "http://x", prdText: "users can log in" }), siteMap, plan: flows, planIterations: 0 };
    const update = await coverageNode(state, { bus, llm, headless: true });
    expect(typeof (update.coverage as CoverageVerdict).score).toBe("number");
    const events = bus.replay();
    expect(events.some((e) => e.type === "error" && e.node === "evaluate_coverage")).toBe(true);
  });

  it("reuses cached prdRequirements from a prior verdict without calling the LLM", async () => {
    const bus = new EventBus("r", outDir + "r/");
    const llm = new FakeLlmClient({});
    const flows = [mk("a1", "happy", "Login works")];
    const priorVerdict: CoverageVerdict = { score: 0.5, gaps: [], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} };
    const state = {
      ...initialState({ runId: "r", url: "http://x", prdText: "users can log in" }),
      siteMap,
      plan: flows,
      planIterations: 1,
      coverage: priorVerdict,
    };
    const update = await coverageNode(state, { bus, llm, headless: true });
    expect(llm.calls).toBe(0);
    expect((update.coverage as CoverageVerdict).prdRequirements).toEqual([]);
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
  it("returns generate when the plan is already at its flow limit, however low the score", () => {
    const bus = new EventBus("r", mkdtempSync(join(tmpdir(), "qa-coverage-")) + "/r/");
    // Every gap asks for a flow the plan has no room for, so another minute-long plan call
    // would hand back the same three flows with a different set of gaps open.
    const state = {
      ...initialState({ runId: "r", url: "http://x", maxFlows: 2 }),
      planIterations: 1,
      plan: [mk("a-001", "happy", "Log in"), mk("b-001", "happy", "Check out")],
      coverage: { score: 0.1, gaps: [{ kind: "missing_authz", target: "/orders", suggest: "add authz flow" }], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} } as CoverageVerdict,
    };
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

describe("scoreCoverage across discovered routes", () => {
  // A login-walled app: the login form is the only form, so a form-only score calls a plan that
  // never leaves the login page complete - even though the catalog and cart went untested.
  const walled: SiteMap = {
    origin: "http://x", loginPath: "/", loginSteps: [],
    pages: {
      "/": { url: "http://x/", path: "/", title: "Login", gated: false, snapshot: "", buttons: [{ role: "button", name: "Login" }], links: [],
        forms: [{ id: "/#0", submit: { role: "button", name: "Login" }, fields: [{ role: "textbox", name: "User", type: "text", required: true }, { role: "textbox", name: "Password", type: "password", required: true }] }] },
      "/catalog": { url: "http://x/catalog", path: "/catalog", title: "Catalog", gated: true, snapshot: "", buttons: [{ role: "button", name: "Add to cart" }], links: [], forms: [] },
      "/basket": { url: "http://x/basket", path: "/basket", title: "Basket", gated: true, snapshot: "", buttons: [{ role: "button", name: "Checkout" }], links: [], forms: [] },
    },
  };
  const authOnly = [
    mk("auth-001", "happy", "User logs in", "/"),
    mk("auth-002", "negative", "Wrong password is rejected", "/"),
    mk("auth-003", "negative", "Empty submit shows validation", "/"),
    mk("auth-004", "edge", "A very long username is rejected", "/"),
    mk("authz-001", "authz", "Catalog is blocked logged out", "/catalog"),
    mk("authz-002", "authz", "Basket is blocked logged out", "/basket"),
  ];

  it("does not call a plan complete when every flow only visits the login page", () => {
    const v = scoreCoverage(walled, authOnly, {});
    expect(v.gaps.map((g) => g.kind)).toContain("missing_route_flow");
    expect(v.score).toBeLessThan(COVERAGE_THRESHOLD);
  });

  it("names the untouched routes so the next plan iteration can close them", () => {
    const targets = scoreCoverage(walled, authOnly, {}).gaps.filter((g) => g.kind === "missing_route_flow").map((g) => g.target);
    expect(targets).toEqual(expect.arrayContaining(["/catalog", "/basket"]));
  });

  it("clears once flows exercise the routes behind the wall", () => {
    const v = scoreCoverage(walled, [...authOnly, mk("cart-001", "happy", "Add an item to the cart", "/catalog"), mk("checkout-001", "happy", "Check out from the basket", "/basket")], {});
    expect(v.gaps.filter((g) => g.kind === "missing_route_flow")).toHaveLength(0);
    expect(v.score).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
  });

  it("ignores a route with nothing to interact with", () => {
    const map: SiteMap = { ...walled, pages: { ...walled.pages, "/legal": { url: "http://x/legal", path: "/legal", title: "Legal", gated: false, snapshot: "", buttons: [], links: [], forms: [] } } };
    expect(scoreCoverage(map, authOnly, {}).gaps.filter((g) => g.target === "/legal")).toHaveLength(0);
  });
});

describe("the coverage gate reads the score it computed", () => {
  it("stores the score unrounded, so display rounding cannot push a plan over the gate", () => {
    // A plan scoring 0.748 is below the gate. Storing it rounded to 0.75 handed a
    // half-covered plan straight to the generator; the UI rounds for display instead.
    const siteMapWith = (paths: string[]): SiteMap => ({
      origin: "http://x", loginPath: "/", loginSteps: [],
      pages: Object.fromEntries(paths.map((p) => [p, { url: `http://x${p}`, path: p, title: p, gated: p !== "/", snapshot: "", links: [], buttons: [{ role: "button", name: "Go" }],
        forms: p === "/" ? [{ id: `${p}#0`, submit: { role: "button", name: "Login" }, fields: [{ role: "textbox", name: "User", type: "text", required: true }] }] : [] }])),
    });
    const map = siteMapWith(["/", "/a", "/b", "/c", "/d"]);
    const flows = [
      mk("auth-001", "happy", "Log in", "/"), mk("auth-002", "negative", "Wrong password", "/"),
      mk("a-001", "authz", "a is blocked", "/a"), mk("b-001", "authz", "b is blocked", "/b"),
      mk("c-001", "authz", "c is blocked", "/c"), mk("d-001", "authz", "d is blocked", "/d"),
      mk("a-002", "happy", "Use a", "/a"), mk("b-002", "edge", "Use b oddly", "/b"),
    ];
    const v = scoreCoverage(map, flows, {});
    expect(v.score).not.toBe(Math.round(v.score * 100) / 100);
    // And the gate reads that same number, so a score a hair under it re-plans.
    const near = { ...initialState({ runId: "r", url: "http://x" }), coverage: { ...v, score: COVERAGE_THRESHOLD - 0.002 }, planIterations: 1 };
    expect(afterCoverage(near, { bus: new EventBus("r", mkdtempSync(join(tmpdir(), "qa-cov-")) + "/"), llm: new FakeLlmClient({}) })).toBe("plan");
  });

  it("counts a route as untested risk when only an authz flow visits it", () => {
    const map: SiteMap = {
      origin: "http://x", loginPath: "/", loginSteps: [],
      pages: { "/cart": { url: "http://x/cart", path: "/cart", title: "Cart", gated: true, snapshot: "", links: [], forms: [], buttons: [{ role: "button", name: "Checkout" }] } },
    };
    const v = scoreCoverage(map, [mk("auth-005", "authz", "Cart is blocked when logged out", "/cart")], {});
    expect(v.untested_risk.map((u) => u.flow)).toEqual(["/cart"]);
  });
});

describe("scoreCoverage credits the routes a flow really reaches", () => {
  // A checkout flow goes inventory -> cart -> checkout by clicking, the way a user does. Only its
  // first step is a goto, so the scorer used to see a flow that never left the inventory page.
  const shop: SiteMap = {
    origin: "http://x", loginPath: "/", loginSteps: [],
    pages: {
      "/": { url: "http://x/", path: "/", title: "Login", gated: false, snapshot: "", buttons: [{ role: "button", name: "Login" }], links: [],
        forms: [{ id: "/#0", submit: { role: "button", name: "Login" }, fields: [{ role: "textbox", name: "User", type: "text", required: true }, { role: "textbox", name: "Password", type: "password", required: true }] }] },
      "/inventory": { url: "http://x/inventory", path: "/inventory", title: "Products", gated: true, snapshot: "", buttons: [{ role: "button", name: "Add to cart" }], links: [], forms: [] },
      "/cart": { url: "http://x/cart", path: "/cart", title: "Cart", gated: true, snapshot: "", buttons: [{ role: "button", name: "Checkout" }], links: [], forms: [] },
      "/checkout": { url: "http://x/checkout", path: "/checkout", title: "Checkout", gated: true, snapshot: "", buttons: [{ role: "button", name: "Continue" }], links: [],
        forms: [{ id: "/checkout#0", submit: { role: "button", name: "Continue" }, fields: [{ role: "textbox", name: "First Name", type: "text", required: true }] }] },
    },
  };
  const clickThrough = (id: string, category: Flow["category"], title: string): Flow => ({
    ...mk(id, category, title, "/inventory"),
    preconditions: ["logged_in"],
    steps: [{ action: "goto", target: "/inventory" }, { action: "click", role: "button", name: "Add to cart" }, { action: "click", role: "link", name: "cart" }, { action: "click", role: "button", name: "Checkout" }, { action: "click", role: "button", name: "Continue" }],
    visits: ["/inventory", "/cart", "/checkout"],
  });
  const flows = [
    mk("auth-001", "happy", "User logs in", "/"),
    mk("auth-002", "negative", "Wrong password is rejected", "/"),
    mk("auth-003", "negative", "Empty submit shows validation", "/"),
    clickThrough("checkout-001", "happy", "Fill in the checkout form and continue"),
    clickThrough("checkout-002", "negative", "Checkout rejects a postal code made of letters"),
    clickThrough("checkout-003", "edge", "Empty checkout form shows the first name error"),
    mk("cart-001", "authz", "Cart is blocked logged out", "/cart"),
    mk("checkout-004", "authz", "Checkout is blocked logged out", "/checkout"),
    mk("catalog-001", "authz", "Products are blocked logged out", "/inventory"),
  ];

  it("counts a form as covered when the flow clicked its way there", () => {
    const v = scoreCoverage(shop, flows, {});
    expect(v.gaps.filter((g) => g.target === "form:/checkout")).toHaveLength(0);
    expect(v.gaps.filter((g) => g.kind === "missing_route_flow")).toHaveLength(0);
    expect(v.untested_risk).toHaveLength(0);
    expect(v.score).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
  });

  it("reads a flow that leaves one field out as the form's negative case, not its empty case", () => {
    const oneFieldOut = flows.map((f) => (f.id === "checkout-002" ? { ...f, title: "Reject checkout when the postal code is missing from the form" } : f));
    const v = scoreCoverage(shop, oneFieldOut, {});
    expect(v.gaps.filter((g) => g.kind === "missing_negative" && g.target === "form:/checkout")).toHaveLength(0);
    expect(v.gaps.filter((g) => g.kind === "missing_empty_submit" && g.target === "form:/checkout")).toHaveLength(0);
  });

  it("does not treat the filler words of an intent as areas to cover", () => {
    const v = scoreCoverage(shop, flows, { intent: "cover the product catalog, the cart and checkout end to end, not just login" });
    const words = v.gaps.filter((g) => g.kind === "intent_uncovered").map((g) => g.target);
    expect(words).not.toContain("cover");
    expect(words).not.toContain("just");
    expect(words).not.toContain("end");
  });
});

describe("scoreCoverage form applicability", () => {
  /** The add-to-cart form on mini-shop's product pages: one optional quantity box. */
  const cartAdd = (path: string) => ({
    url: `http://x${path}`, path, title: "Product", gated: false, snapshot: "", buttons: [], links: [],
    forms: [{ id: `${path}#0`, submit: { role: "button", name: "Add to cart" }, fields: [{ role: "spinbutton", name: "Quantity", type: "number", required: false }] }],
  });
  const shop = (paths: string[]): SiteMap => ({
    origin: "http://x", loginPath: null, loginSteps: [],
    pages: Object.fromEntries(paths.map((p) => [p, cartAdd(p)])),
  });

  it("asks for no empty-submit case on a form that requires nothing", () => {
    const v = scoreCoverage(shop(["/products/p1"]), [mk("c1", "happy", "Add to cart", "/products/p1")], {});
    expect(v.gaps.map((g) => g.kind)).not.toContain("missing_empty_submit");
  });

  it("counts one form shared across product pages once, and any page covers it", () => {
    const v = scoreCoverage(shop(["/products/p1", "/products/p2", "/products/p3"]), [mk("c1", "happy", "Add to cart", "/products/p2")], {});
    expect(v.gaps.filter((g) => g.kind === "missing_happy")).toHaveLength(0);
    expect(v.gaps.filter((g) => g.kind === "missing_negative")).toHaveLength(1);
  });
});
