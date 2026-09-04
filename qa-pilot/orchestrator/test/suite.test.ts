import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSuite, renderFixtures, renderConfig, renderPackageJson, renderReadme, SUITE_USERNAME_VAR, SUITE_PASSWORD_VAR } from "../src/suite/bundle.js";
import { initialState, type Classification, type Flow, type HealRecord, type Step, type TestResult } from "../src/state.js";

const loginSteps: Step[] = [
  { action: "goto", target: "/login", intent: "open login page" },
  { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "enter username" },
  { action: "fill", role: "textbox", name: "Password", value: "hunter2-secret", intent: "enter password" },
  { action: "click", role: "button", name: "Sign in", intent: "submit login form" },
];
const credentials = { username: "demo@shop.test", password: "hunter2-secret" };

describe("renderFixtures", () => {
  it("bakes the login steps but reads the credentials from the environment", () => {
    const src = renderFixtures(loginSteps, credentials);
    expect(src).not.toContain("hunter2-secret");
    expect(src).toContain(`process.env.${SUITE_USERNAME_VAR}`);
    expect(src).toContain(`process.env.${SUITE_PASSWORD_VAR}`);
    expect(src).toContain(`{ action: "fill", role: "textbox", name: "Email", value: USERNAME }`);
    expect(src).toContain(`{ action: "click", role: "button", name: "Sign in" }`);
  });
  it("makes a missing credential fail loudly instead of signing in as nobody", () => {
    expect(renderFixtures(loginSteps, credentials)).toMatch(/throw new Error\(/);
  });
  it("emits a no-op login for a run that never signed in", () => {
    const src = renderFixtures([], undefined);
    expect(src).toContain("LOGIN_STEPS: Step[] = []");
    expect(src).not.toContain("process.env." + SUITE_USERNAME_VAR);
  });
});

describe("renderConfig", () => {
  it("targets the app the run tested and lets the environment override it, with no pipeline variables left", () => {
    const src = renderConfig("http://localhost:3005");
    expect(src).toContain(`process.env.BASE_URL ?? "http://localhost:3005"`);
    expect(src).toContain('testDir: "./tests"');
    expect(src).not.toMatch(/QA_PILOT_/);
  });
});

describe("renderPackageJson", () => {
  it("pins the Playwright version the suite was generated against", () => {
    const pkg = JSON.parse(renderPackageJson("1.62.1"));
    expect(pkg.devDependencies["@playwright/test"]).toBe("1.62.1");
    expect(pkg.scripts.test).toBe("playwright test");
  });
});

const flow = (id: string, extra: Partial<Flow> = {}): Flow => ({
  id, title: `Flow ${id}`, category: "happy", priority: "P1", preconditions: ["logged_in"], source: "explored",
  steps: [{ action: "goto", target: "/x" }], expected: [{ type: "url_contains", value: "/x" }], ...extra,
});

function stateWith(dir: string) {
  const state = {
    ...initialState({ runId: "r", url: "http://localhost:3005", credentials }),
    siteMap: { origin: "http://localhost:3005", loginPath: "/login", loginSteps, pages: {} },
    plan: [flow("auth-001"), flow("checkout-001"), flow("checkout-002")],
    results: {
      tests: [
        { id: "auth-001", file: `${dir}auth-001.spec.ts`, title: "Flow auth-001", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
        { id: "checkout-001", file: `${dir}checkout-001.spec.ts`, title: "Flow checkout-001", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
        { id: "checkout-002", file: `${dir}checkout-002.spec.ts`, title: "Flow checkout-002", status: "failed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
      ] as TestResult[],
      at: "",
    },
    classifications: [{ test: "checkout-002", class: "defect", confidence: 0.9, evidence: ["POST /api/coupon returned 500"], action: "escalate" }] as Classification[],
    healLog: [{ test: "checkout-001", attempt: 1, step: 1, before: "a", after: "b", reason: "renamed", confidence: 0.9, accepted: true }] as HealRecord[],
  };
  return state;
}

describe("buildSuite", () => {
  function withSpecs() {
    const dir = mkdtempSync(join(tmpdir(), "qa-suite-")) + "/";
    mkdirSync(dir, { recursive: true });
    for (const id of ["auth-001", "checkout-001", "checkout-002"]) {
      writeFileSync(`${dir}${id}.spec.ts`, `import { test, expect } from '/abs/path/runner/fixtures';\n// flow: ${id}\ntest('${id}', async ({ page, login }) => {\n  await login();\n});\n`);
    }
    return dir;
  }

  it("packages every generated spec with its imports pointing at the bundled fixtures", () => {
    const dir = withSpecs();
    const entries = buildSuite(stateWith(dir));
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["README.md", "fixtures.ts", "package.json", "playwright.config.ts", "tests/auth-001.spec.ts", "tests/checkout-001.spec.ts", "tests/checkout-002.spec.ts"]);
    const spec = entries.find((e) => e.path === "tests/auth-001.spec.ts")!.content;
    expect(spec).toContain(`from '../fixtures'`);
    expect(spec).not.toContain("/abs/path/runner");
  });

  it("tells the reader which tests were healed and which are known application defects", () => {
    const readme = buildSuite(stateWith(withSpecs())).find((e) => e.path === "README.md")!.content;
    expect(readme).toContain(SUITE_USERNAME_VAR);
    expect(readme).toContain("checkout-001");
    expect(readme).toContain("checkout-002");
    expect(readme).toMatch(/POST \/api\/coupon returned 500/);
  });

  it("explains every test that is red, including one the classifier could not call", () => {
    const dir = withSpecs();
    const state = stateWith(dir);
    state.results.tests[0] = { ...state.results.tests[0], status: "failed" };
    state.classifications = [
      ...state.classifications,
      { test: "auth-001", class: "needs_human", confidence: 0.4, evidence: ["assertion failed with no script-side explanation"], action: "needs_human" },
    ];
    const readme = buildSuite(state).find((e) => e.path === "README.md")!.content;
    // Both red tests are accounted for: one as an application defect, one as undecided.
    expect(readme).toMatch(/auth-001[\s\S]*needs a human|needs a human[\s\S]*auth-001/);
    expect(readme).toContain("assertion failed with no script-side explanation");
    expect(readme).toContain("checkout-002");
  });

  it("never writes the target application's password into the bundle", () => {
    for (const entry of buildSuite(stateWith(withSpecs()))) expect(entry.content).not.toContain("hunter2-secret");
  });

  it("omits a spec that was planned but never generated", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-suite-none-")) + "/";
    const entries = buildSuite(stateWith(dir));
    expect(entries.filter((e) => e.path.startsWith("tests/"))).toEqual([]);
  });
});
