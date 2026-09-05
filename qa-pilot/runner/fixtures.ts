import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Step = { action: "goto" | "fill" | "click" | "select" | "press" | "check"; target?: string; role?: string; name?: string; value?: string };

const loginSteps: Step[] = JSON.parse(process.env.QA_PILOT_LOGIN_STEPS ?? "[]");

/** Frames closer together than this are dropped: the viewer polls at 4 fps, so anything faster is wasted disk churn. */
const FRAME_INTERVAL_MS = 200;

/**
 * Each page's true, unpatched `waitForLoadState`, recorded before the `page` fixture below
 * redirects `'networkidle'` calls through `settle()`. `settle()` needs this: it waits on
 * `networkidle` itself, and if it went through `page.waitForLoadState` after the redirect was
 * installed it would call straight back into itself - infinite recursion, a stack overflow on
 * every test. A page never registered here (none exist outside this fixture) falls back to its
 * own current method.
 */
const rawWaitForLoadState = new WeakMap<Page, Page["waitForLoadState"]>();

/**
 * Gives client-side rendering a moment to finish after a navigation or a click/press that may
 * trigger one (a submit, a nav link). `networkidle` alone is not a safe proxy for "the app has
 * hydrated": a SPA that keeps a websocket, a poll, or a telemetry beacon running never goes
 * quiet, so an unbounded wait for it burns time confirming nothing. Racing it against a
 * concrete DOM signal - some interactive content actually attached - resolves the instant real
 * content shows up, while the network-idle leg still wins fast on a page that genuinely settles.
 */
async function settle(page: Page): Promise<void> {
  const waitForLoadState = rawWaitForLoadState.get(page) ?? page.waitForLoadState.bind(page);
  await Promise.race([
    waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}),
    page.waitForSelector("form, input, button, a[href]", { timeout: 6000 }).catch(() => {}),
  ]);
  await dismissOnboardingOverlay(page);
}

/**
 * The wait after a click or press, which needs a different signal than a fresh navigation does.
 *
 * `settle`'s selector leg exists because a goto can start from an empty DOM. A click starts
 * from a page that already has all of that - the form just submitted is still on screen,
 * mid-submit ("Signing in...") - so the same selector matches instantly and "wins" the race
 * before the async work the click triggered has gone anywhere: a login POST, reported settled
 * while the button still reads "Signing in...", so the very next check reads the stale page.
 * Network-idle answers the right question for a click, so it runs alone, for the full budget.
 */
async function settleAfterAction(page: Page): Promise<void> {
  const waitForLoadState = rawWaitForLoadState.get(page) ?? page.waitForLoadState.bind(page);
  await waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await dismissOnboardingOverlay(page);
}

/** Labels a first-run overlay dismisses itself with, never a label that commits to anything. */
const DISMISS_LABELS = /^(skip|close|dismiss|got it|no thanks|not now|maybe later|later|×|✕|x)$/i;

/**
 * Closes a first-run onboarding dialog if one is covering the page, so a link sitting right
 * behind it - visible, correctly located, but not receiving pointer events because the
 * dialog's backdrop intercepts them - doesn't read as a click timeout. Only a labelled,
 * no-commitment dismissal is pressed, never one of the survey's own options.
 */
async function dismissOnboardingOverlay(page: Page): Promise<void> {
  try {
    const dialog = page.getByRole("dialog").first();
    if (!(await dialog.isVisible({ timeout: 500 }).catch(() => false))) return;
    for (const b of await dialog.getByRole("button").all()) {
      const name = ((await b.textContent().catch(() => "")) ?? "").trim();
      if (DISMISS_LABELS.test(name)) {
        await b.click({ timeout: 1000 }).catch(() => {});
        return;
      }
    }
  } catch {
    /* best effort */
  }
}

async function runStep(page: Page, s: Step): Promise<void> {
  if (s.action === "goto") {
    await page.goto(s.target ?? "/", { waitUntil: "domcontentloaded" });
    await settle(page);
    return;
  }
  const loc = page.getByRole(s.role as never, { name: s.name });
  switch (s.action) {
    case "fill": await loc.fill(s.value ?? ""); break;
    case "click": await loc.click(); await settleAfterAction(page); break;
    case "select": await loc.selectOption(s.value ?? ""); break;
    case "press": await loc.press(s.value ?? "Enter"); await settleAfterAction(page); break;
    case "check": await loc.check(); break;
  }
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Streams the page to `<liveDir>/<testId>/frame.jpg` while the test runs, so the UI can
 * show the browser as it is being driven. Uses the Chromium screencast over CDP: it costs
 * nothing when nothing repaints and needs no per-action hook in the generated tests.
 * Any failure here is swallowed - a missing preview must never fail a test.
 */
async function startLivePreview(page: Page, dir: string, title: string): Promise<() => Promise<void>> {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "state.json"), JSON.stringify({ status: "running", title, startedAt: new Date().toISOString() }));
  try {
    const cdp = await page.context().newCDPSession(page);
    let last = 0;
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      const now = Date.now();
      if (now - last < FRAME_INTERVAL_MS) return;
      last = now;
      try { writeAtomic(join(dir, "frame.jpg"), Buffer.from(frame.data, "base64")); } catch { /* disk hiccup: skip the frame */ }
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 });
    return async () => {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    };
  } catch {
    return async () => {};
  }
}

export const test = base.extend<{ login: () => Promise<void> }>({
  page: async ({ page }, use, testInfo) => {
    // Generated (and self-repaired) specs reach for the idiomatic `page.waitForLoadState`
    // themselves - the self-repair LLM has no way to know about `settle()`, only about the
    // standard Playwright API, and its patches routinely add a bare, unbounded
    // `waitForLoadState('networkidle')` to wait out a redirect. Against an app that never
    // goes network-idle that call just hangs until the default timeout and then throws,
    // failing the very test the repair was meant to fix. Redirecting every `'networkidle'`
    // call through settleAfterAction, not settle, because this call is just as likely to
    // follow a click as a goto and settle's selector leg is wrong for that case: it matches
    // whatever the click's own page already had on it - a submit form still reading "Signing
    // in..." - and resolves before the async work the click triggered goes anywhere.
    const originalWaitForLoadState = page.waitForLoadState.bind(page);
    rawWaitForLoadState.set(page, originalWaitForLoadState);
    page.waitForLoadState = (async (state?: Parameters<typeof originalWaitForLoadState>[0], options?: { timeout?: number }) => {
      if (state === "networkidle") return settleAfterAction(page);
      return originalWaitForLoadState(state, options);
    }) as typeof page.waitForLoadState;

    const network: { method: string; url: string; status: number; at: number }[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) network.push({ method: r.request().method(), url: r.url(), status: r.status(), at: Date.now() });
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    const liveRoot = process.env.QA_PILOT_LIVE_DIR;
    const testId = basename(testInfo.file).replace(/\.spec\.ts$/, "");
    const liveDir = liveRoot ? join(liveRoot, testId) : null;
    const stopPreview = liveDir ? await startLivePreview(page, liveDir, testInfo.title) : async () => {};

    await use(page);

    await stopPreview();
    if (liveDir) {
      try { writeAtomic(join(liveDir, "state.json"), JSON.stringify({ status: "finished", title: testInfo.title, finishedAt: new Date().toISOString() })); } catch { /* best effort */ }
    }
    testInfo.annotations.push({ type: "network", description: JSON.stringify(network) });
    testInfo.annotations.push({ type: "console", description: JSON.stringify(consoleErrors) });
    testInfo.annotations.push({ type: "pageerror", description: JSON.stringify(pageErrors) });
  },
  login: async ({ page }, use) => {
    // The last login step is always the submit click, which already settles inside runStep.
    await use(async () => {
      for (const s of loginSteps) await runStep(page, s);
    });
  },
});
export { expect };
