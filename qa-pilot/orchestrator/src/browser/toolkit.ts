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

/** How long to wait for an element. Short on purpose: "this locator does not resolve" is a
 *  verdict the planner, generator and healer all act on, and each of them pays this in full. */
export const ELEMENT_TIMEOUT_MS = 5000;
/** How long to wait for a page to load. A real target over a real network routinely needs more
 *  than the element timeout - a slow first paint used to fail the very first goto of a crawl and
 *  take the whole run down with it - so navigation gets its own, generous budget. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

function applyTimeouts(context: BrowserContext): void {
  context.setDefaultTimeout(ELEMENT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
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
    applyTimeouts(context);
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
    applyTimeouts(ctx);
    return ctx;
  }

  async snapshot(page: Page): Promise<string> {
    return page.locator("body").ariaSnapshot();
  }

  async screenshot(page: Page, label: string): Promise<string> {
    if (!this.shotDir) return "";
    const now = Date.now();
    if (now - this.lastShot < 500) return "";
    this.lastShot = now;
    const file = `${this.shotDir}/${now}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`;
    await page.screenshot({ path: file });
    this.bus?.emit({ type: "screenshot", agent: this.agent, message: label, data: { path: file } });
    return file;
  }

  /** Executes one step. Returns the resolved locator (a placeholder for goto) or null when unresolvable. */
  async act(page: Page, step: Step): Promise<ResolvedLocator | null> {
    this.bus?.log(this.agent, `${step.action} ${step.role ?? ""} ${step.name ?? step.target ?? ""}`.trim());
    if (step.action === "goto") {
      const url = step.target?.startsWith("http") ? step.target : this.baseUrl + (step.target ?? "/");
      await page.goto(url, { waitUntil: "domcontentloaded" });
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
      await page.waitForLoadState("domcontentloaded").catch(() => {});
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
