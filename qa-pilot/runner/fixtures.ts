import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Step = { action: "goto" | "fill" | "click" | "select" | "press" | "check"; target?: string; role?: string; name?: string; value?: string };

const loginSteps: Step[] = JSON.parse(process.env.QA_PILOT_LOGIN_STEPS ?? "[]");

/** Frames closer together than this are dropped: the viewer polls at 4 fps, so anything faster is wasted disk churn. */
const FRAME_INTERVAL_MS = 200;

async function runStep(page: Page, s: Step): Promise<void> {
  if (s.action === "goto") {
    await page.goto(s.target ?? "/");
    return;
  }
  const loc = page.getByRole(s.role as never, { name: s.name });
  switch (s.action) {
    case "fill": await loc.fill(s.value ?? ""); break;
    case "click": await loc.click(); break;
    case "select": await loc.selectOption(s.value ?? ""); break;
    case "press": await loc.press(s.value ?? "Enter"); break;
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
    await use(async () => {
      for (const s of loginSteps) await runStep(page, s);
      await page.waitForLoadState("networkidle").catch(() => {});
    });
  },
});
export { expect };
