import type { Page } from "playwright";
import { BrowserToolkit, gotoWithRetry } from "../browser/toolkit.js";
import { parseSnapshot } from "../browser/snapshot.js";
import { outputDir, type Credentials, type FormInfo, type PageInfo, type RunState, type RunUpdate, type SiteMap, type Step } from "../state.js";
import { BLOCKLIST, now, type NodeDeps } from "./deps.js";

async function extractForms(page: Page, path: string): Promise<FormInfo[]> {
  const raw = await page.locator("form").evaluateAll((forms) =>
    forms.map((form) => {
      const fields = Array.from(form.querySelectorAll("input, select, textarea"))
        .filter((el) => !["hidden", "submit", "button"].includes((el as HTMLInputElement).type))
        .map((el) => {
          const input = el as HTMLInputElement;
          const label = input.labels?.[0]?.textContent?.replace(input.value ?? "", "").trim() || input.getAttribute("aria-label") || input.placeholder || input.name;
          const tag = el.tagName.toLowerCase();
          const role = tag === "select" ? "combobox" : input.type === "checkbox" ? "checkbox" : input.type === "radio" ? "radio" : input.type === "number" ? "spinbutton" : "textbox";
          return { role, name: label, type: input.type || tag, required: input.required };
        });
      const submit = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
      return { fields, submit: submit ? { role: "button", name: (submit.textContent || (submit as HTMLInputElement).value || "").trim() } : null };
    }),
  );
  return raw.map((f, i) => ({ id: `${path}#${i}`, ...f }));
}

/**
 * The route a URL addresses: its pathname, plus the fragment when the app routes on hashes
 * (`/#/faq`). Every page key in the site map is one of these, and `goto` accepts them as-is.
 */
export function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + (u.hash.startsWith("#/") ? u.hash : "");
}

/** Gives client-side rendering a moment to finish; a page that never goes idle is read as it is. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

type Link = { href: string; text: string };

async function collectLinks(page: Page): Promise<Link[]> {
  await settle(page);
  return page.locator("a[href]").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim() })));
}

/** Navigation controls that are not anchors: what a single-page app routes with. Submit buttons act on forms, so they are left alone. */
const NAV_PROBE_SELECTOR = "nav button:not([type=submit]), header button:not([type=submit]), [role=navigation] button:not([type=submit]), [role=link]:not([href]), [data-href], [routerlink], [routerLink]";
const MAX_PROBES_PER_PAGE = 10;

/**
 * Clicks each navigation control on the page once and records where it leads. A control
 * counts as a link when the route changes and stays on the origin; the page is reloaded
 * after every probe so one click never colours the next. Blocklisted labels are never
 * pressed, and a label is probed once per crawl no matter how many pages repeat it.
 */
async function probeNav(kit: BrowserToolkit, page: Page, origin: string, path: string, probed: Set<string>): Promise<Link[]> {
  const labels = await page.locator(NAV_PROBE_SELECTOR).evaluateAll((els) => els.map((el) => (el.textContent ?? el.getAttribute("aria-label") ?? "").trim()));
  const found: Link[] = [];
  let probes = 0;
  for (const text of labels) {
    if (!text || probed.has(text) || BLOCKLIST.test(text) || probes >= MAX_PROBES_PER_PAGE) continue;
    probed.add(text);
    probes++;
    try {
      const control = page.locator(NAV_PROBE_SELECTOR).filter({ hasText: text }).first();
      await control.click({ timeout: 2000 });
      await settle(page);
      const landed = page.url();
      if (landed.startsWith(origin) && pathOf(landed) !== path) found.push({ href: landed, text });
    } catch {
      /* not clickable right now: nothing to record */
    }
    if (pathOf(page.url()) !== path) await kit.act(page, { action: "goto", target: path }).catch(() => {});
  }
  return found;
}

async function pageInfo(kit: BrowserToolkit, page: Page, origin: string, probed?: Set<string>): Promise<PageInfo> {
  const url = page.url();
  const path = pathOf(url);
  const links = await collectLinks(page);
  const snapshot = await kit.snapshot(page);
  const nodes = parseSnapshot(snapshot);
  const title = await page.title();
  const forms = await extractForms(page, path);
  const buttons = nodes.filter((n) => n.role === "button").map((n) => ({ role: "button", name: n.name }));
  if (probed) links.push(...(await probeNav(kit, page, origin, path, probed)));
  return { url, path, title, forms, buttons, links: links.filter((l) => l.href.startsWith(origin)), gated: false, snapshot };
}

/** Keeps only same-origin links whose text isn't blocklisted and whose path isn't a logout link, returning routes. */
export function filterLinks(links: Link[], origin: string): string[] {
  return links
    .filter((l) => l.href.startsWith(origin))
    .filter((l) => !BLOCKLIST.test(l.text))
    .filter((l) => !/logout|signout/i.test(new URL(l.href).pathname))
    .map((l) => pathOf(l.href));
}

/** Finds the first form with a password field, fills it, submits, and returns the steps taken plus the
 *  login page's PageInfo (captured before credentials are filled, so it survives even if an authenticated
 *  visit later redirects away from the login path). */
async function tryLogin(
  kit: BrowserToolkit,
  page: Page,
  loginPath: string,
  origin: string,
  creds: Credentials,
): Promise<{ steps: Step[]; loginPage: PageInfo } | null> {
  await kit.act(page, { action: "goto", target: loginPath });
  const loginPage = await pageInfo(kit, page, origin);
  const form = loginPage.forms.find((f) => f.fields.some((x) => x.type === "password"));
  if (!form) return null;
  const pw = form.fields.find((x) => x.type === "password")!;
  const user = form.fields.find((x) => x !== pw && x.role === "textbox");
  if (!user || !form.submit) return null;
  const steps: Step[] = [
    { action: "goto", target: loginPath, intent: "open login page" },
    { action: "fill", role: "textbox", name: user.name, value: creds.username, intent: "enter username" },
    { action: "fill", role: "textbox", name: pw.name, value: creds.password, intent: "enter password" },
    { action: "click", role: "button", name: form.submit.name, value: undefined, intent: "submit login form" },
  ];
  for (const s of steps.slice(1)) if (!(await kit.act(page, s))) return null;
  await page.waitForLoadState("networkidle").catch(() => {});
  return pathOf(page.url()) === loginPath ? null : { steps, loginPage };
}

export async function crawl(kit: BrowserToolkit, opts: { credentials?: Credentials; maxPages?: number; maxDepth?: number; bus?: NodeDeps["bus"] }): Promise<SiteMap> {
  const maxPages = opts.maxPages ?? 30;
  const maxDepth = opts.maxDepth ?? 3;
  const origin = new URL(kit.baseUrl).origin;
  const page = await kit.newPage();
  const pages: Record<string, PageInfo> = {};
  let loginPath: string | null = null;
  let loginSteps: Step[] = [];

  // Discover a login page first so we can log in before the crawl.
  await kit.act(page, { action: "goto", target: "/" });
  const homeLinks = await collectLinks(page);
  // The landing page is very often the login page itself: saucedemo.com, and most internal
  // tools and admin panels, put the form at "/" with nothing linking to it. Searching only
  // for a *link* matching /login|sign-in/ finds nothing on such an app, so loginPath stayed
  // null, tryLogin was never called, and the crawl reported a cheerful "1 page, 0 gated"
  // having silently ignored the credentials it was given. So look for the form on the page
  // we are already standing on first, and keep the link scan for apps that do link out to a
  // separate login page (mini-shop does, which is why this held for so long).
  const homeHasPasswordField = await page
    .locator('input[type="password"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (homeHasPasswordField) {
    loginPath = pathOf(page.url());
  } else {
    const candidate = homeLinks.map((h) => pathOf(h.href)).find((p) => /log-?in|sign-?in/i.test(p));
    if (candidate) loginPath = candidate;
  }
  // Pages reachable only from the unauthenticated nav (e.g. "/register") won't be linked once we're
  // logged in, so seed the queue with everything visible before login happens - filtered the same way
  // as the main loop (same-origin, not blocklisted, not a logout link).
  const preLoginPaths = filterLinks(homeLinks, origin);
  if (loginPath && opts.credentials) {
    const result = await tryLogin(kit, page, loginPath, origin, opts.credentials);
    if (result) {
      loginSteps = result.steps;
      pages[loginPath] = result.loginPage;
      opts.bus?.log("explorer", `logged in via ${loginPath}`);
    } else opts.bus?.log("explorer", `login attempt at ${loginPath} did not leave the page`);
  } else if (opts.credentials) {
    // Credentials were supplied and never used. Silence here reads as a successful crawl of
    // a tiny app, when in fact everything behind the sign-in was missed.
    opts.bus?.log("explorer", `credentials were provided but no login form was found; crawling unauthenticated`);
  }

  const queue: { path: string; depth: number }[] = [{ path: "/", depth: 0 }];
  for (const p of preLoginPaths) queue.push({ path: p, depth: 1 });
  if (loginPath) queue.push({ path: loginPath, depth: 1 });
  const seen = new Set<string>();
  const probed = new Set<string>();
  while (queue.length && Object.keys(pages).length < maxPages) {
    const { path, depth } = queue.shift()!;
    if (seen.has(path) || depth > maxDepth) continue;
    seen.add(path);
    try {
      await kit.act(page, { action: "goto", target: path });
    } catch {
      continue;
    }
    const finalPath = pathOf(page.url());
    let info: PageInfo;
    try {
      info = await pageInfo(kit, page, origin, probed);
    } catch (e) {
      const message = (e as Error).message.split("\n")[0];
      opts.bus?.log("explorer", `extraction failed for ${path}: ${message}`);
      continue;
    }
    // Only the landing page's own path is ever recorded (never an alias under the pre-redirect `path`),
    // and only once - this keeps `pages` bounded to at most maxPages entries.
    if (!(finalPath in pages)) pages[finalPath] = info;
    // The structured payload is what the Sources screen counts pages with; the message
    // stays human-readable for the feed. Never make the UI parse the sentence.
    opts.bus?.log("explorer", `visited ${finalPath} (${info.forms.length} forms, ${info.buttons.length} buttons)`, {
      visited: finalPath, forms: info.forms.length, buttons: info.buttons.length,
    });
    for (const p of filterLinks(info.links, origin)) {
      if (!seen.has(p)) queue.push({ path: p, depth: depth + 1 });
    }
  }
  await page.close();

  // Gating: revisit each path unauthenticated.
  const anon = await kit.newContext();
  const anonPage = await anon.newPage();
  for (const path of Object.keys(pages)) {
    try {
      // Retried, because the catch below reads a failure as "not gated" - a wrong answer
      // rather than a missing one, which would silently drop this route's authz flows.
      await gotoWithRetry(anonPage, origin + path);
      await settle(anonPage);
      const landed = pathOf(anonPage.url());
      pages[path].gated = landed !== path && loginPath !== null && landed === loginPath;
    } catch {
      /* unreachable page: leave gated=false */
    }
  }
  await anon.close();
  return { origin, loginPath, loginSteps, pages };
}

export async function exploreNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "explore" });
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent: "explorer", screenshotDir: outputDir(state.runId) + "traces/explore" });
  try {
    const siteMap = await crawl(kit, { credentials: state.credentials, bus: deps.bus });
    deps.bus.decision({ node: "explore", reason: `discovered ${Object.keys(siteMap.pages).length} pages, ${Object.values(siteMap.pages).filter((p) => p.gated).length} gated`, evidence: Object.keys(siteMap.pages), next: "plan", at: now() });
    deps.bus.emit({ type: "node_end", node: "explore" });
    return { siteMap };
  } finally {
    await kit.close();
  }
}
