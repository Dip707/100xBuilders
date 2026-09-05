import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { outputDir, type Credentials, type RunState, type Step } from "../state.js";
import { writeOutput } from "../output.js";
import type { ZipEntry } from "./zip.js";

/** Where a run's take-home suite lands, under the run's output directory. */
export const SUITE_DIR = "suite";

/**
 * The take-home suite. A run's generated specs only execute inside the pipeline: they import
 * the runner's fixtures by a path that exists here, and their `login()` replays steps handed
 * in through an environment variable the orchestrator sets. Handed to an engineer as-is, every
 * signed-in test would sign in as nobody and fail on its first assertion.
 *
 * This module re-packages the same specs as a standalone Playwright project: the fixtures and
 * config travel with them, the login steps are baked in, and the credentials are read from the
 * environment so the bundle stays safe to commit.
 */

/** Environment variables the bundled suite reads its target credentials from. */
export const SUITE_USERNAME_VAR = "QA_USERNAME";
export const SUITE_PASSWORD_VAR = "QA_PASSWORD";

const str = (s: string) => JSON.stringify(s);

/** One login step as TypeScript, with credential values swapped for the constants that read the environment. */
function stepLiteral(step: Step, credentials: Credentials | undefined): string {
  const parts = [`action: ${str(step.action)}`];
  if (step.target !== undefined) parts.push(`target: ${str(step.target)}`);
  if (step.role !== undefined) parts.push(`role: ${str(step.role)}`);
  if (step.name !== undefined) parts.push(`name: ${str(step.name)}`);
  if (step.value !== undefined) {
    const secret = credentials && step.value === credentials.password ? "PASSWORD" : credentials && step.value === credentials.username ? "USERNAME" : null;
    parts.push(`value: ${secret ?? str(step.value)}`);
  }
  return `  { ${parts.join(", ")} },`;
}

export function renderFixtures(loginSteps: Step[], credentials: Credentials | undefined): string {
  const needsCredentials = Boolean(credentials) && loginSteps.some((s) => s.value === credentials!.password || s.value === credentials!.username);
  const lines = [
    `import { test as base, expect, type Page } from "@playwright/test";`,
    ``,
    `type Step = { action: "goto" | "fill" | "click" | "select" | "press" | "check"; target?: string; role?: string; name?: string; value?: string };`,
    ``,
  ];
  if (needsCredentials) {
    lines.push(
      `// Credentials for the application under test. They are read from the environment, never`,
      `// stored in this file, so the suite is safe to commit. See README.md.`,
      `const USERNAME = process.env.${SUITE_USERNAME_VAR} ?? "";`,
      `const PASSWORD = process.env.${SUITE_PASSWORD_VAR} ?? "";`,
      ``,
    );
  }
  lines.push(
    `/** The sign-in the agent recorded against this application. */`,
    loginSteps.length === 0 ? `const LOGIN_STEPS: Step[] = [];` : `const LOGIN_STEPS: Step[] = [\n${loginSteps.map((s) => stepLiteral(s, credentials)).join("\n")}\n];`,
    ``,
    `/**`,
    ` * Gives client-side rendering a moment to finish after a navigation or a click/press that`,
    ` * may trigger one (a submit, a nav link). \`networkidle\` alone is not a safe proxy for "the`,
    ` * app has hydrated": a SPA that keeps a websocket, a poll, or a telemetry beacon running`,
    ` * never goes quiet, so an unbounded wait for it burns time confirming nothing. Racing it`,
    ` * against a concrete DOM signal - some interactive content actually attached - resolves the`,
    ` * instant real content shows up, while the network-idle leg still wins fast on a page that`,
    ` * genuinely settles.`,
    ` */`,
    `/**`,
    ` * Each page's true, unpatched waitForLoadState, recorded before the page fixture below`,
    ` * redirects 'networkidle' calls through settle(). settle() needs this: it waits on`,
    ` * networkidle itself, and if it went through page.waitForLoadState after the redirect was`,
    ` * installed it would call straight back into itself - infinite recursion on every test.`,
    ` */`,
    `const rawWaitForLoadState = new WeakMap<Page, Page["waitForLoadState"]>();`,
    ``,
    `async function settle(page: Page): Promise<void> {`,
    `  const waitForLoadState = rawWaitForLoadState.get(page) ?? page.waitForLoadState.bind(page);`,
    `  await Promise.race([`,
    `    waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}),`,
    `    page.waitForSelector("form, input, button, a[href]", { timeout: 6000 }).catch(() => {}),`,
    `  ]);`,
    `  await dismissOnboardingOverlay(page);`,
    `}`,
    ``,
    `// The wait after a click/press needs network-idle alone, not settle()'s selector race: a`,
    `// click's page already has everything that selector matches (the form it just submitted,`,
    `// still reading "Signing in..."), so the race resolves before the click's own async work does.`,
    `async function settleAfterAction(page: Page): Promise<void> {`,
    `  const waitForLoadState = rawWaitForLoadState.get(page) ?? page.waitForLoadState.bind(page);`,
    `  await waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});`,
    `  await dismissOnboardingOverlay(page);`,
    `}`,
    ``,
    `/** Labels a first-run overlay dismisses itself with, never a label that commits to anything. */`,
    `const DISMISS_LABELS = /^(skip|close|dismiss|got it|no thanks|not now|maybe later|later|×|✕|x)$/i;`,
    ``,
    `/**`,
    ` * Closes a first-run onboarding dialog if one is covering the page, so a link sitting right`,
    ` * behind it - visible, correctly located, but not receiving pointer events because the`,
    ` * dialog's backdrop intercepts them - doesn't read as a click timeout. Only a labelled,`,
    ` * no-commitment dismissal is pressed, never one of the survey's own options.`,
    ` */`,
    `async function dismissOnboardingOverlay(page: Page): Promise<void> {`,
    `  try {`,
    `    const dialog = page.getByRole("dialog").first();`,
    `    if (!(await dialog.isVisible({ timeout: 500 }).catch(() => false))) return;`,
    `    for (const b of await dialog.getByRole("button").all()) {`,
    `      const name = ((await b.textContent().catch(() => "")) ?? "").trim();`,
    `      if (DISMISS_LABELS.test(name)) {`,
    `        await b.click({ timeout: 1000 }).catch(() => {});`,
    `        return;`,
    `      }`,
    `    }`,
    `  } catch {`,
    `    /* best effort */`,
    `  }`,
    `}`,
    ``,
    `async function runStep(page: Page, s: Step): Promise<void> {`,
    `  if (s.action === "goto") {`,
    `    await page.goto(s.target ?? "/", { waitUntil: "domcontentloaded" });`,
    `    await settle(page);`,
    `    return;`,
    `  }`,
    `  const loc = page.getByRole(s.role as never, { name: s.name });`,
    `  switch (s.action) {`,
    `    case "fill": await loc.fill(s.value ?? ""); break;`,
    `    case "click": await loc.click(); await settleAfterAction(page); break;`,
    `    case "select": await loc.selectOption(s.value ?? ""); break;`,
    `    case "press": await loc.press(s.value ?? "Enter"); await settleAfterAction(page); break;`,
    `    case "check": await loc.check(); break;`,
    `  }`,
    `}`,
    ``,
    `/**`,
    ` * Fixtures for the generated suite: a \`login\` that replays the recorded sign-in, and`,
    ` * per-test capture of failed responses, console errors and uncaught exceptions, attached`,
    ` * to the test so a failure carries its own evidence.`,
    ` */`,
    `export const test = base.extend<{ login: () => Promise<void> }>({`,
    `  page: async ({ page }, use, testInfo) => {`,
    // Redirect any generated (or self-repaired) spec's bare page.waitForLoadState('networkidle')
    // through the bounded settle() race, so a spec written against the idiomatic Playwright API
    // never hangs and throws against an app that never reaches network-idle.
    `    const originalWaitForLoadState = page.waitForLoadState.bind(page);`,
    `    rawWaitForLoadState.set(page, originalWaitForLoadState);`,
    `    page.waitForLoadState = (async (state?: Parameters<typeof originalWaitForLoadState>[0], options?: { timeout?: number }) => {`,
    `      if (state === "networkidle") return settleAfterAction(page);`,
    `      return originalWaitForLoadState(state, options);`,
    `    }) as typeof page.waitForLoadState;`,
    `    const network: { method: string; url: string; status: number }[] = [];`,
    `    const consoleErrors: string[] = [];`,
    `    const pageErrors: string[] = [];`,
    `    page.on("response", (r) => { if (r.status() >= 400) network.push({ method: r.request().method(), url: r.url(), status: r.status() }); });`,
    `    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });`,
    `    page.on("pageerror", (e) => pageErrors.push(e.message));`,
    `    await use(page);`,
    `    testInfo.annotations.push({ type: "network", description: JSON.stringify(network) });`,
    `    testInfo.annotations.push({ type: "console", description: JSON.stringify(consoleErrors) });`,
    `    testInfo.annotations.push({ type: "pageerror", description: JSON.stringify(pageErrors) });`,
    `  },`,
    `  login: async ({ page }, use) => {`,
    `    await use(async () => {`,
  );
  if (needsCredentials) {
    lines.push(
      `      // Without this the sign-in would submit an empty form and every assertion that`,
      `      // follows would fail for a reason that has nothing to do with the application.`,
      `      if (!USERNAME || !PASSWORD) {`,
      `        throw new Error("set ${SUITE_USERNAME_VAR} and ${SUITE_PASSWORD_VAR} before running the signed-in tests (see README.md)");`,
      `      }`,
    );
  }
  lines.push(
    // The last login step is always the submit click, which already settles inside runStep.
    `      for (const s of LOGIN_STEPS) await runStep(page, s);`,
    `    });`,
    `  },`,
    `});`,
    `export { expect };`,
    ``,
  );
  return lines.join("\n");
}

export function renderConfig(baseUrl: string): string {
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 4),
  retries: Number(process.env.RETRIES ?? 0),
  // A navigation against a real site can take tens of seconds, and a flow makes several,
  // so the per-test cap leaves room for more than one of them.
  timeout: Number(process.env.TEST_TIMEOUT_MS ?? 60_000),
  expect: { timeout: Number(process.env.EXPECT_TIMEOUT_MS ?? 5_000) },
  reporter: [["html", { open: "never" }], ["line"]],
  use: {
    baseURL: process.env.BASE_URL ?? ${str(baseUrl)},
    // A bounded action timeout turns a missing element into a locator error naming the step,
    // instead of letting the whole test run out its timeout with nothing to show for it.
    // Navigation is given a much larger budget on purpose: a slow site is not a broken one.
    actionTimeout: Number(process.env.ACTION_TIMEOUT_MS ?? 10_000),
    navigationTimeout: Number(process.env.NAV_TIMEOUT_MS ?? 30_000),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
});
`;
}

export function renderPackageJson(playwrightVersion: string): string {
  return `${JSON.stringify(
    {
      name: "qa-pilot-suite",
      private: true,
      version: "1.0.0",
      scripts: { test: "playwright test", report: "playwright show-report" },
      devDependencies: { "@playwright/test": playwrightVersion },
    },
    null,
    2,
  )}\n`;
}

export function renderReadme(state: RunState, ids: string[]): string {
  const needsCredentials = Boolean(state.credentials) && (state.siteMap?.loginSteps.length ?? 0) > 0;
  const byId = new Map(state.plan.map((f) => [f.id, f]));
  const healed = [...new Set(state.healLog.filter((h) => h.accepted).map((h) => h.test))].filter((id) => ids.includes(id));
  const defects = state.classifications.filter((c) => c.class === "defect" && ids.includes(c.test));
  const md: string[] = [
    `# Test suite for ${state.url}`,
    ``,
    `Generated by qa-pilot in run \`${state.runId}\`. Every test here was written and validated by the agent against the running application; none were written by hand.`,
    ``,
    `## Run it`,
    ``,
    "```bash",
    `npm install`,
    `npx playwright install chromium`,
  ];
  if (needsCredentials) md.push(`export ${SUITE_USERNAME_VAR}='...'`, `export ${SUITE_PASSWORD_VAR}='...'`);
  md.push(`npm test`, "```", ``);
  if (needsCredentials) {
    md.push(
      `The signed-in tests replay the sign-in the agent recorded, using the credentials from \`${SUITE_USERNAME_VAR}\` and \`${SUITE_PASSWORD_VAR}\`.`,
      `Those values are deliberately not stored in this bundle, so it is safe to commit. A signed-in test fails with a clear message if they are unset.`,
      ``,
    );
  }
  md.push(
    `\`BASE_URL\` overrides the target, so the same suite can run against another environment.`,
    ``,
    `## What is covered`,
    ``,
    `| Test | Flow | Category | Priority |`,
    `| --- | --- | --- | --- |`,
  );
  for (const id of ids) {
    const f = byId.get(id);
    md.push(`| \`${id}.spec.ts\` | ${f?.title ?? id} | ${f?.category ?? "-"} | ${f?.priority ?? "-"} |`);
  }
  md.push(``);
  if (healed.length) {
    md.push(
      `## Repaired by the healer`,
      ``,
      `These tests broke against the application and the agent repaired the locator, never the assertion. They are included in their repaired form.`,
      ``,
      ...healed.map((id) => `- \`${id}\``),
      ``,
    );
  }
  // Every test that was still red when the run ended, so nothing in the bundle is
  // unexplained. A red test with no note reads as a broken suite rather than a finding.
  const failing = (state.results?.tests ?? []).filter((t) => t.status !== "passed" && ids.includes(t.id));
  if (failing.length) {
    const verdict = new Map(state.classifications.map((c) => [c.test, c]));
    md.push(
      `## Known failures`,
      ``,
      `These tests were red when the suite was generated, and are included as they are.`,
      ``,
    );
    for (const t of failing) {
      const c = verdict.get(t.id);
      const label =
        c?.class === "defect"
          ? `application defect, confidence ${c.confidence.toFixed(2)}. It should stay red until the application is fixed.`
          : c?.class === "needs_human"
            ? `needs a human: the agent could not tell a test problem from an application one (confidence ${c.confidence.toFixed(2)}).`
            : c
              ? `${c.class}, confidence ${c.confidence.toFixed(2)}.`
              : `no verdict was recorded.`;
      md.push(`- \`${t.id}\`: ${label}`, ...(c?.evidence ?? []).slice(0, 3).map((e) => `  - ${e}`));
    }
    md.push(``);
  }
  md.push(`## Layout`, ``, `- \`tests/\` one spec per user flow, named after it`, `- \`fixtures.ts\` the sign-in and the per-test network, console and page-error capture`, `- \`playwright.config.ts\` the target, timeouts, traces, screenshots and video`, ``);
  return md.join("\n");
}

/** Every file of a run's suite bundle, relative to the bundle root, for zipping on request. */
export function readSuite(runId: string): ZipEntry[] {
  const root = `${outputDir(runId)}${SUITE_DIR}/`;
  if (!existsSync(root)) return [];
  const walk = (dir: string, prefix: string): ZipEntry[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name), `${prefix}${d.name}/`) : [{ path: `${prefix}${d.name}`, content: readFileSync(join(dir, d.name), "utf8") }],
    );
  return walk(root, "");
}

/** Rewrites a generated spec's fixtures import so it resolves inside the bundle. */
export function rewriteImport(source: string): string {
  return source.replace(/^import \{([^}]*)\} from ['"][^'"]*fixtures['"];/m, `import {$1} from '../fixtures';`);
}

/**
 * The bundle for a finished run: every spec that actually made it to disk, plus the fixtures,
 * config, manifest and README needed to run them anywhere.
 */
export function buildSuite(state: RunState, playwrightVersion = "1.62.1"): ZipEntry[] {
  const specs = (state.results?.tests ?? [])
    .filter((t) => existsSync(t.file))
    .map((t) => ({ path: `tests/${t.id}.spec.ts`, content: rewriteImport(readFileSync(t.file, "utf8")), id: t.id }));
  return [
    { path: "README.md", content: renderReadme(state, specs.map((s) => s.id)) },
    { path: "package.json", content: renderPackageJson(playwrightVersion) },
    { path: "playwright.config.ts", content: renderConfig(state.url) },
    { path: "fixtures.ts", content: renderFixtures(state.siteMap?.loginSteps ?? [], state.credentials) },
    ...specs.map(({ path, content }) => ({ path, content })),
  ];
}

/** Writes the bundle under the run's output directory and returns the files written. */
export function writeSuite(state: RunState, playwrightVersion?: string): string[] {
  const entries = buildSuite(state, playwrightVersion);
  for (const e of entries) writeOutput(state.runId, `${SUITE_DIR}/${e.path}`, e.content);
  return entries.map((e) => e.path);
}
