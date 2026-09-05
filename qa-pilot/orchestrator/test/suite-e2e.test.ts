import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { buildSuite } from "../src/suite/bundle.js";
import { initialState, type Step, type TestResult } from "../src/state.js";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { await shop.stop(); });

const credentials = { username: "demo@shop.test", password: "demo1234" };
const loginSteps: Step[] = [
  { action: "goto", target: "/login" },
  { action: "fill", role: "textbox", name: "Email", value: credentials.username },
  { action: "fill", role: "textbox", name: "Password", value: credentials.password },
  { action: "click", role: "button", name: "Sign in" },
];

/** A spec shaped exactly as the generator writes one: pipeline fixtures import, login fixture, role locators. */
const generatedSpec = (id: string, body: string) =>
  `import { test, expect } from '/some/absolute/path/runner/fixtures';\n// flow: ${id} | category: happy | source: explored\ntest('${id}', async ({ page, login }) => {\n  await login();\n${body}});\n`;

/** Lays the bundle down on disk and points it at the repo's Playwright install instead of running npm install. */
function materialise(entries: { path: string; content: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-bundle-")) + "/";
  for (const e of entries) {
    const full = dir + e.path;
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, e.content);
  }
  symlinkSync(new URL("../../node_modules", import.meta.url).pathname, dir + "node_modules");
  return dir;
}

/** Async on purpose: mini-shop is served from this very process, so blocking the event loop would hang every request. */
function runSuite(dir: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "test", "--reporter=line"], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function state(dir: string) {
  const file = (id: string) => `${dir}${id}.spec.ts`;
  return {
    ...initialState({ runId: "r", url: shop.base, credentials }),
    siteMap: { origin: shop.base, loginPath: "/login", loginSteps, pages: {} },
    plan: [],
    results: {
      tests: [
        { id: "orders-001", file: file("orders-001"), title: "orders-001", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
        { id: "home-001", file: file("home-001"), title: "home-001", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
      ] as TestResult[],
      at: "",
    },
  };
}

describe("the downloaded suite", () => {
  it("passes on a machine that has only the bundle, with credentials supplied from the environment", async () => {
    const specs = mkdtempSync(join(tmpdir(), "qa-specs-")) + "/";
    // A signed-in flow: it only passes if the bundled login actually signed in.
    writeFileSync(`${specs}orders-001.spec.ts`, generatedSpec("orders-001", "  await page.goto('/orders');\n  await expect(page).toHaveURL(/\\/orders/);\n  await expect(page.getByRole('link', { name: 'Log out' })).toBeVisible();\n"));
    writeFileSync(`${specs}home-001.spec.ts`, generatedSpec("home-001", "  await page.goto('/');\n  await expect(page.getByRole('heading', { name: 'Everyday things, thoughtfully made.' })).toBeVisible();\n"));
    const dir = materialise(buildSuite(state(specs)));

    const run = await runSuite(dir, { QA_USERNAME: credentials.username, QA_PASSWORD: credentials.password, BASE_URL: shop.base });
    expect(run.output).toMatch(/2 passed/);
    expect(run.code).toBe(0);
  }, 180_000);

  it("fails with an explanation, not a silent sign-in as nobody, when the credentials are missing", async () => {
    const specs = mkdtempSync(join(tmpdir(), "qa-specs2-")) + "/";
    writeFileSync(`${specs}orders-001.spec.ts`, generatedSpec("orders-001", "  await page.goto('/orders');\n  await expect(page).toHaveURL(/\\/orders/);\n"));
    writeFileSync(`${specs}home-001.spec.ts`, generatedSpec("home-001", "  await page.goto('/');\n"));
    const dir = materialise(buildSuite(state(specs)));

    const run = await runSuite(dir, { QA_USERNAME: "", QA_PASSWORD: "", BASE_URL: shop.base });
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/set QA_USERNAME and QA_PASSWORD/);
  }, 180_000);
});
