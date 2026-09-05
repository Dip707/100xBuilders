import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import type { Step, Expectation } from "../state.js";
import type { EventBus } from "../events.js";
import { resolveLocator, quote as q, type ResolvedLocator } from "./locators.js";
import { UNIQUE_PLACEHOLDER, valueCode } from "../codegen/template.js";
import { getScreencast, screencastEnabled, type ScreencastHub } from "./screencast.js";

const re = (s: string) => `/${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;

/** The default locator code for an expectation's target; `checkExpectation` may refine it live. */
export function expectationTargetCode(exp: Expectation): string {
  return exp.role && exp.name
    ? `page.getByRole(${q(exp.role)}, { name: ${q(exp.name)} })`
    : exp.role
      ? `page.getByRole(${q(exp.role)})`
      : "page.locator('body')";
}

export function expectationCode(exp: Expectation, target: string = expectationTargetCode(exp)): string {
  switch (exp.type) {
    case "visible":
      return exp.text_contains
        ? `await expect(${target}).toContainText(${valueCode(exp.text_contains)});`
        : `await expect(${target}).toBeVisible();`;
    case "not_visible":
      return `await expect(${target}).not.toBeVisible();`;
    case "text_contains":
      return `await expect(${target}).toContainText(${valueCode(exp.text_contains ?? "")});`;
    case "url_contains":
    case "url_stays":
      // The planner occasionally files the path under text_contains; falling back to it
      // keeps the assertion meaningful instead of degrading to a match-anything "/".
      return `await expect(page).toHaveURL(${re(exp.value ?? exp.text_contains ?? "/")});`;
    case "value_equals":
      return `await expect(${target}).toHaveValue(${valueCode(exp.value ?? "")});`;
  }
}

/**
 * How long an *action* may take: resolving a locator, clicking, filling.
 *
 * Deliberately short, and deliberately not shared with navigation. The classifier depends
 * on a click against a missing element failing fast with a locator error that names the
 * step; raise this and Playwright waits out the whole test instead, reporting `timedOut`
 * with no error location, which leaves the classifier and the healer nothing to work with.
 */
export function actionTimeoutMs(): number {
  const raw = Number(process.env.QA_PILOT_ACTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * How long a *navigation* may take.
 *
 * Much larger, because it answers a different question. Five seconds is generous against a
 * target on localhost and too tight for a real site over the internet - saucedemo.com
 * answers in 4.2-5.6s, straddling the old shared budget, so exploring it died on the very
 * first `page.goto` before the crawl had begun. A slow site is not a broken one.
 */
export function navigationTimeoutMs(): number {
  const raw = Number(process.env.QA_PILOT_NAV_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

/** The same budgets as constants, for callers that read them once at import time. */
export const ELEMENT_TIMEOUT_MS = actionTimeoutMs();
export const NAVIGATION_TIMEOUT_MS = navigationTimeoutMs();
/** How long a screenshot may take. It is decoration, so it gets less than an element. */
export const SCREENSHOT_TIMEOUT_MS = 3000;

/**
 * A fixed pause after every step, on top of whatever settle already waited for.
 *
 * The crawler moving through a real app faster than the app's own session bookkeeping can
 * keep up with has shown up as being logged out mid-crawl: settle only waits for a concrete
 * readiness signal (network idle, or some content existing), and a signal firing is not the
 * same guarantee as the app having finished whatever it does after that - a session refresh,
 * an analytics beacon, a debounced state write - before the very next action lands.
 */
export function postActionDelayMs(): number {
  const raw = Number(process.env.QA_PILOT_POST_ACTION_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long `settle` waits for a page to show real content before giving up on it. */
export function settleTimeoutMs(): number {
  const raw = Number(process.env.QA_PILOT_SETTLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6000;
}

/**
 * Gives client-side rendering a moment to finish. `networkidle` alone is not a safe proxy for
 * "the app has hydrated": a SPA that keeps a websocket, a poll, or a telemetry beacon running
 * never goes quiet, so the wait burns its whole budget and returns having confirmed nothing -
 * observed against a real target where a login form was still absent at domcontentloaded and
 * only rendered a few seconds in, past a fixed cap, so extraction read an empty page and a
 * correct login was read as "form not found". A click that submits a login or otherwise
 * triggers a client-side redirect has the same problem one step later: the app may still be
 * mid-navigation when the very next step fires, landing it on a route that has not
 * authenticated yet - the two failures share one cause and one fix.
 *
 * Racing a concrete DOM signal - some interactive content actually attached - resolves the
 * instant real content shows up, while the network-idle leg still wins fast on the common case
 * of a page that genuinely settles. A page that renders nothing within the window is read as it
 * is either way.
 */
export async function settle(page: Page): Promise<void> {
  const timeout = settleTimeoutMs();
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout }).catch(() => {}),
    page.waitForSelector("form, input, button, a[href]", { timeout }).catch(() => {}),
  ]);
  await dismissOnboardingOverlay(page);
}

/**
 * The wait after a click or press, which needs a different signal than a fresh navigation does.
 *
 * `settle`'s selector leg exists because a goto can start from an empty DOM - nothing has
 * rendered yet, so "some interactive content exists" is real progress. A click starts from a
 * page that already has all of that: the form just submitted is still on screen, mid-submit, so
 * the same selector matches instantly and "wins" the race before the async work the click
 * triggered - a login POST, here - has gone anywhere. `settle` then reports done while the
 * button still reads "Signing in...", and the very next check reads the old, unchanged page.
 * Network-idle answers the right question for a click - is whatever request this triggered
 * still in flight - so it runs alone, for the full budget, with no earlier-satisfied signal to
 * cut it short.
 */
export async function settleAfterAction(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: settleTimeoutMs() }).catch(() => {});
  await dismissOnboardingOverlay(page);
}

/** Labels a first-run overlay dismisses itself with, never a label that commits to anything. */
const DISMISS_LABELS = /^(skip|close|dismiss|got it|no thanks|not now|maybe later|later|×|✕|x)$/i;

/**
 * Closes a first-run onboarding dialog if one is covering the page.
 *
 * A fresh page load of this app - any hard navigation, not just the first login ever - shows a
 * "What best describes your role?" modal on top of the real content. The sidebar links behind
 * it are visible and correctly located, so every symptom reads as a rendering race: a click
 * "times out" waiting for a link that is sitting right there, because Playwright's actionability
 * check requires the target to be receiving pointer events and the dialog's backdrop is
 * intercepting them. No amount of waiting for content fixes that - the content is already
 * there, wrongly hidden behind a survey. Only a labelled, no-commitment dismissal is pressed
 * (never the survey's own options), so a dialog that is not this kind of overlay is left alone.
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
    /* best effort: a page with no overlay, or one that closed itself mid-check, is left alone */
  }
}

/** Navigations to retry: a timeout, a dropped connection, a DNS blip. Not a 404. */
function isTransientNavError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Timeout \d+ms exceeded|net::ERR_(CONNECTION|NETWORK|NAME_NOT_RESOLVED|TIMED_OUT|ABORTED|EMPTY_RESPONSE)/i.test(m);
}

/**
 * Navigates, retrying a transient failure.
 *
 * A single slow response used to end the whole run: `page.goto` throws, the node's
 * `guarded()` wrapper catches it, marks the run partial and jumps to the report. That is
 * right for a broken node and wrong for a site having a bad moment - and against a target
 * on localhost, where navigation never fails, the difference never showed up. Exploring a
 * real site, it ended two runs before the crawl had produced anything.
 *
 * Attempts share the context's navigation timeout, so the ceiling is bounded by it.
 */
export async function gotoWithRetry(
  page: { goto: (url: string, opts: { waitUntil: "domcontentloaded" }) => Promise<unknown> },
  url: string,
  opts: { attempts?: number; delayMs?: number; log?: (m: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = opts.attempts ?? navRetryAttempts();
  const delay = opts.delayMs ?? 1000;
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (err) {
      if (!isTransientNavError(err) || i === attempts - 1) throw err;
      opts.log?.(`navigation to ${url} failed (${(err as Error).message.split("\n")[0]}); retrying ${i + 2}/${attempts}`);
      await nap(delay * (i + 1));
    }
  }
}

/** How many times a navigation is attempted before the node gives up. */
export function navRetryAttempts(): number {
  const raw = Number(process.env.QA_PILOT_NAV_RETRIES);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * How much accessibility snapshot a prompt may carry, in characters. 0 disables the cap.
 *
 * Deliberately tunable rather than fixed, because the right answer depends on the model. The
 * evidence splits: compaction reliably helps small and mid-tier models, which lose the thread
 * in a long observation, and can *hurt* frontier models with a large thinking budget, which do
 * better with the raw tree. We run a flash-tier model by default, so the default caps.
 *
 * Truncation is on a line boundary and leaves an explicit marker: a model handed a silently
 * cut-off tree will reasonably conclude the page ends there and report a missing element as a
 * defect. Saying how much was dropped turns a wrong answer into a known-partial one.
 */
export const maxSnapshotChars = (): number => Number(process.env.QA_PILOT_MAX_SNAPSHOT_CHARS ?? 12000);

export function budgetSnapshot(yaml: string, max = maxSnapshotChars()): string {
  if (max <= 0 || yaml.length <= max) return yaml;
  const lines = yaml.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n[snapshot truncated to ${max} characters; ${dropped} more element line(s) not shown]`;
}

export class BrowserToolkit {
  private lastShot = 0;
  /** This toolkit's substitute for the planner's unique placeholder; every launch mints a fresh one. */
  public readonly unique = Math.random().toString(36).slice(2, 10);

  private fill(s: string): string {
    return s.split(UNIQUE_PLACEHOLDER).join(this.unique);
  }

  /**
   * The page whose frames are currently broadcast. An agent may hold several pages open at
   * once (generate opens a throwaway page to re-snapshot the DOM while its main page waits);
   * broadcasting all of them under one agent name would make the tile flip between two
   * unrelated views, so only the newest page is live and the rest are silently acknowledged.
   */
  private activePage: Page | null = null;

  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    public readonly baseUrl: string,
    private bus?: EventBus,
    private agent = "browser",
    private shotDir?: string,
    private cast?: ScreencastHub,
  ) {}

  static async launch(opts: {
    headless?: boolean;
    baseUrl: string;
    bus?: EventBus;
    agent?: string;
    screenshotDir?: string;
    /** Streams this toolkit's viewport to the run screen. Omitted (as in tests), nothing is cast. */
    runId?: string;
  }): Promise<BrowserToolkit> {
    // Headless is the default: generate fans out one toolkit per planned flow, so a headed
    // default means a dozen Chromium windows fighting for focus on the demo machine. The
    // live view is served by the screencast below instead - and it *needs* headless, because
    // a headed Chromium stops painting a window that is not frontmost, so every agent but
    // the one on top would stream a frozen picture.
    const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS !== "0";
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    context.setDefaultTimeout(actionTimeoutMs());
    context.setDefaultNavigationTimeout(navigationTimeoutMs());
    if (opts.screenshotDir) mkdirSync(opts.screenshotDir, { recursive: true });
    const cast = opts.runId && screencastEnabled() ? getScreencast(opts.runId) : undefined;
    return new BrowserToolkit(browser, context, opts.baseUrl.replace(/\/$/, ""), opts.bus, opts.agent ?? "browser", opts.screenshotDir, cast);
  }

  async newPage(): Promise<Page> {
    const page = await this.context.newPage();
    await this.startCast(page);
    return page;
  }

  /**
   * Wipes the session so the next `newPage()` starts logged out.
   *
   * A caller that checks several flows against one toolkit - the classifier replaying each
   * failure in turn - shares one context and therefore one cookie jar across all of them. A
   * flow with `logged_in` leaves a valid session on that context, and every flow checked after
   * it inherits that session even when its own precondition is `logged_out`: the goto that
   * should hit the sign-in page instead lands on the authenticated app, and the evidence
   * gathered describes the wrong page entirely.
   */
  async clearCookies(): Promise<void> {
    await this.context.clearCookies();
  }

  /**
   * Mirrors `page` to the run screen over CDP. Chromium keeps sending frames only while each
   * one is acknowledged, so every frame is acked even when the hub's rate limit drops it or
   * the page is not the active one. Failures here are never fatal: a broken screencast must
   * not take down the agent that was only incidentally being watched.
   */
  private async startCast(page: Page): Promise<void> {
    if (!this.cast) return;
    const hub = this.cast;
    const previous = this.activePage;
    this.activePage = page;
    try {
      const cdp: CDPSession = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
        if (page === this.activePage) hub.push(this.agent, f.data);
        cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      });
      page.once("close", () => {
        void cdp.detach().catch(() => {});
        if (this.activePage !== page) return;
        // Hand the tile back to the page this one interrupted, if it is still open.
        this.activePage = previous && !previous.isClosed() ? previous : null;
        if (!this.activePage) hub.close(this.agent);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 45, maxWidth: 640, maxHeight: 400, everyNthFrame: 1 });
    } catch (e) {
      // Nothing will ever close this page's tile, so give it straight back rather than
      // leaving the agent pointing at a page it is not broadcasting.
      this.activePage = previous && !previous.isClosed() ? previous : null;
      this.bus?.log(this.agent, `screencast unavailable: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  async newContext(): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({ viewport: { width: 1200, height: 800 } });
    ctx.setDefaultTimeout(actionTimeoutMs());
    ctx.setDefaultNavigationTimeout(navigationTimeoutMs());
    return ctx;
  }

  async snapshot(page: Page): Promise<string> {
    return budgetSnapshot(await page.locator("body").ariaSnapshot());
  }

  async screenshot(page: Page, label: string): Promise<string> {
    if (!this.shotDir) return "";
    const now = Date.now();
    if (now - this.lastShot < 500) return "";
    this.lastShot = now;
    const file = `${this.shotDir}/${now}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`;
    // A screenshot is a picture for the run screen, never part of the verdict. A page that
    // is still animating, mid-navigation or already closed cannot be captured, and that must
    // cost the agent a picture, not the step - a screenshot timeout once took a whole run down
    // from inside the planner.
    try {
      await page.screenshot({ path: file, timeout: SCREENSHOT_TIMEOUT_MS, animations: "disabled" });
    } catch (e) {
      this.bus?.log(this.agent, `screenshot skipped: ${(e as Error).message.split("\n")[0]}`);
      return "";
    }
    this.bus?.emit({ type: "screenshot", agent: this.agent, message: label, data: { path: file } });
    return file;
  }

  /** Executes one step. Returns the resolved locator (a placeholder for goto) or null when unresolvable. */
  async act(page: Page, step: Step): Promise<ResolvedLocator | null> {
    this.bus?.log(this.agent, `${step.action} ${step.role ?? ""} ${step.name ?? step.target ?? ""}`.trim());
    if (step.action === "goto") {
      // A relative target is always a root-relative route ("/document-stores"), the same
      // shape pathOf/filterLinks and every site-map key use - it must resolve against the
      // origin, not against baseUrl verbatim. baseUrl is whatever URL the run was pointed at,
      // which is very often not the origin itself: a user naming the app's login page as its
      // URL (https://host/sso/login) turned every later "/document-stores" into
      // "https://host/sso/login/document-stores" by plain string concatenation - a path the
      // app's own router doesn't recognise, so it 404s. Every route this crawled beyond the
      // first was reading that 404 page, not the app.
      const origin = new URL(this.baseUrl).origin;
      const url = step.target?.startsWith("http") ? step.target : new URL(step.target ?? "/", origin).toString();
      await gotoWithRetry(page, url, { log: (m) => this.bus?.log(this.agent, m) });
      // A fresh navigation can start from an empty DOM - domcontentloaded fires before a SPA
      // has hydrated - so whatever step comes next (a fill, a click) must not run until
      // something real has actually rendered. explore.ts's own crawl dodges this by calling
      // pageInfo (which settles) between every goto and the next action, but every other
      // caller replaying a flow's own steps - the planner's dry walk, the generator, the
      // classifier, the healer - goes straight from this goto into whatever step.act comes
      // next, with nothing else in between to settle it first.
      await settle(page);
      await sleep(postActionDelayMs());
      await this.screenshot(page, `goto ${step.target ?? ""}`);
      return { locator: page.locator("body"), code: "", strategy: "css" };
    }
    const r = await resolveLocator(page, { role: step.role, name: step.name });
    if (!r) {
      this.bus?.log(this.agent, `unresolved: ${step.role ?? ""} "${step.name ?? ""}"`);
      return null;
    }
    try {
      switch (step.action) {
        case "fill":
          await r.locator.fill(this.fill(step.value ?? ""));
          break;
        case "click":
          await r.locator.click();
          break;
        case "select":
          await r.locator.selectOption(this.fill(step.value ?? ""));
          break;
        case "press":
          await r.locator.press(step.value ?? "Enter");
          break;
        case "check":
          await r.locator.check();
          break;
      }
      // click and press are the two actions that routinely trigger a client-side redirect
      // (a submit, a nav link): domcontentloaded alone can resolve while the app is still
      // mid-navigation, so the very next step fires against a page that has not finished
      // authenticating or routing yet. fill/select/check don't carry that risk and keep the
      // cheaper wait, so a plain form fill is never taxed for a problem it doesn't have.
      if (step.action === "click" || step.action === "press") await settleAfterAction(page);
      else await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(postActionDelayMs());
      await this.screenshot(page, `${step.action} ${step.name ?? ""}`);
      return r;
    } catch (e) {
      this.bus?.log(this.agent, `action failed: ${(e as Error).message.split("\n")[0]}`);
      return null;
    }
  }

  /**
   * Verifies an expectation live and returns the expect line to emit. A role+name target is
   * resolved the same way a step is: the loose name match first, and `exact: true` only when
   * the loose match is ambiguous, so the emitted assertion can never trip strict mode on the
   * page it was validated against.
   */
  async checkExpectation(page: Page, exp: Expectation, _startUrl: string): Promise<{ ok: boolean; actual: string; code: string }> {
    let targetCode = expectationTargetCode(exp);
    let target = exp.role ? page.getByRole(exp.role as never).first() : page.locator("body");
    if (exp.role && exp.name) {
      const loose = page.getByRole(exp.role as never, { name: exp.name });
      target = loose;
      if ((await loose.count().catch(() => 0)) > 1) {
        const exact = page.getByRole(exp.role as never, { name: exp.name, exact: true });
        if ((await exact.count().catch(() => 0)) === 1) {
          target = exact;
          targetCode = `page.getByRole(${q(exp.role)}, { name: ${q(exp.name)}, exact: true })`;
        } else {
          // Several elements share the name even exactly (a product's image link and title
          // link): the expectation is about the first of them, the same way a step that names
          // a repeated control acts on the first. Emitting the bare locator would hand the
          // runner a strict mode violation at every execution.
          target = loose.first();
          targetCode = `page.getByRole(${q(exp.role)}, { name: ${q(exp.name)} }).first()`;
        }
      }
    }
    const code = expectationCode(exp, targetCode);
    const wanted = this.fill(exp.text_contains ?? "");
    try {
      switch (exp.type) {
        case "visible": {
          await target.waitFor({ state: "visible", timeout: 3000 });
          const text = (await target.innerText()).trim();
          const ok = wanted ? text.toLowerCase().includes(wanted.toLowerCase()) : true;
          return { ok, actual: text, code };
        }
        case "not_visible": {
          const ok = (await target.count()) === 0 || !(await target.first().isVisible());
          return { ok, actual: ok ? "hidden" : "visible", code };
        }
        case "text_contains": {
          const text = (await target.innerText()).trim();
          return { ok: text.toLowerCase().includes(wanted.toLowerCase()), actual: text, code };
        }
        case "url_contains":
        case "url_stays": {
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          const url = page.url();
          const ok = url.includes(exp.value ?? exp.text_contains ?? "");
          return { ok, actual: url, code };
        }
        case "value_equals": {
          const v = await target.inputValue();
          return { ok: v === this.fill(exp.value ?? ""), actual: v, code };
        }
      }
    } catch (e) {
      const message = (e as Error).message.split("\n")[0];
      this.bus?.log(this.agent, `expectation check failed: ${message}`);
      return { ok: false, actual: message, code };
    }
  }

  async close(): Promise<void> {
    this.cast?.close(this.agent);
    this.activePage = null;
    await this.browser.close();
  }
}
