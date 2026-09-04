import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import type { Step, Expectation } from "../state.js";
import type { EventBus } from "../events.js";
import { resolveLocator, quote as q, type ResolvedLocator } from "./locators.js";

const re = (s: string) => `/${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;

export function expectationCode(exp: Expectation): string {
  const target =
    exp.role && exp.name
      ? `page.getByRole(${q(exp.role)}, { name: ${q(exp.name)} })`
      : exp.role
        ? `page.getByRole(${q(exp.role)})`
        : "page.locator('body')";
  switch (exp.type) {
    case "visible":
      return exp.text_contains
        ? `await expect(${target}).toContainText(${q(exp.text_contains)});`
        : `await expect(${target}).toBeVisible();`;
    case "not_visible":
      return `await expect(${target}).not.toBeVisible();`;
    case "text_contains":
      return `await expect(${target}).toContainText(${q(exp.text_contains ?? "")});`;
    case "url_contains":
    case "url_stays":
      return `await expect(page).toHaveURL(${re(exp.value ?? "/")});`;
    case "value_equals":
      return `await expect(${target}).toHaveValue(${q(exp.value ?? "")});`;
  }
}

export class BrowserToolkit {
  private lastShot = 0;

  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    public readonly baseUrl: string,
    private bus?: EventBus,
    private agent = "browser",
    private shotDir?: string,
  ) {}

  static async launch(opts: {
    headless?: boolean;
    baseUrl: string;
    bus?: EventBus;
    agent?: string;
    screenshotDir?: string;
  }): Promise<BrowserToolkit> {
    const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS === "1";
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    context.setDefaultTimeout(5000);
    if (opts.screenshotDir) mkdirSync(opts.screenshotDir, { recursive: true });
    return new BrowserToolkit(browser, context, opts.baseUrl.replace(/\/$/, ""), opts.bus, opts.agent ?? "browser", opts.screenshotDir);
  }

  async newPage(): Promise<Page> {
    return this.context.newPage();
  }

  async newContext(): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({ viewport: { width: 1200, height: 800 } });
    ctx.setDefaultTimeout(5000);
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
          await r.locator.fill(step.value ?? "");
          break;
        case "click":
          await r.locator.click();
          break;
        case "select":
          await r.locator.selectOption(step.value ?? "");
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

  async checkExpectation(page: Page, exp: Expectation, _startUrl: string): Promise<{ ok: boolean; actual: string; code: string }> {
    const code = expectationCode(exp);
    const target =
      exp.role && exp.name
        ? page.getByRole(exp.role as never, { name: exp.name })
        : exp.role
          ? page.getByRole(exp.role as never).first()
          : page.locator("body");
    try {
      switch (exp.type) {
        case "visible": {
          await target.waitFor({ state: "visible", timeout: 3000 });
          const text = (await target.innerText()).trim();
          const ok = exp.text_contains ? text.toLowerCase().includes(exp.text_contains.toLowerCase()) : true;
          return { ok, actual: text, code };
        }
        case "not_visible": {
          const ok = (await target.count()) === 0 || !(await target.first().isVisible());
          return { ok, actual: ok ? "hidden" : "visible", code };
        }
        case "text_contains": {
          const text = (await target.innerText()).trim();
          return { ok: text.toLowerCase().includes((exp.text_contains ?? "").toLowerCase()), actual: text, code };
        }
        case "url_contains":
        case "url_stays": {
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          const url = page.url();
          const ok = url.includes(exp.value ?? "");
          return { ok, actual: url, code };
        }
        case "value_equals": {
          const v = await target.inputValue();
          return { ok: v === (exp.value ?? ""), actual: v, code };
        }
      }
    } catch (e) {
      const message = (e as Error).message.split("\n")[0];
      this.bus?.log(this.agent, `expectation check failed: ${message}`);
      return { ok: false, actual: message, code };
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
