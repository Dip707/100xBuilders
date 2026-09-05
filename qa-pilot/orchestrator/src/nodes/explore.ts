import type { Page } from "playwright";
import { BrowserToolkit, gotoWithRetry, settle } from "../browser/toolkit.js";
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

type Link = { href: string; text: string };

async function collectLinks(page: Page): Promise<Link[]> {
  await settle(page);
  return page.locator("a[href]").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim() })));
}

/**
 * Controls that route without being a usable link. Three families, and every one of them is
 * something `a[href]` collection cannot see:
 *  - anchors an SPA hangs a click handler on, which carry no href, an empty one, or "#";
 *  - explicit link/router roles;
 *  - buttons that sit outside any form, including submit-styled ones - a button styled
 *    `type=submit` with no form around it submits nothing, so it is navigation, not a form
 *    action. Anything inside a form is left alone: that belongs to the form's own flow.
 */
const NAV_PROBE_SELECTOR = [
  "a:not([href]):not(form *)",
  'a[href=""]:not(form *)',
  'a[href="#"]:not(form *)',
  "[role=link]:not([href]):not(form *)",
  "[data-href]:not(form *)",
  "[routerlink]:not(form *)",
  "[routerLink]:not(form *)",
  "button:not(form *)",
  "[role=button]:not(form *)",
].join(", ");

const MAX_PROBES_PER_PAGE = 12;
/** Probing costs a click and a reload each, so the whole crawl gets a ceiling too. */
const MAX_PROBES_PER_CRAWL = 60;

type ProbeBudget = { labels: Set<string>; spent: number };
const newProbeBudget = (): ProbeBudget => ({ labels: new Set(), spent: 0 });

/**
 * What to call a control: visible text first, then the attributes an app labels an icon-only
 * control with. An anchor holding nothing but a cart glyph still needs a name, both to dedupe
 * it across pages and to say what was clicked.
 */
const LABEL_ATTRS = ["aria-label", "data-test", "data-testid", "title", "name", "id"];

/**
 * Clicks each navigation control on the page once and records where it leads. A control
 * counts as a link when the route changes and stays on the origin; the page is reloaded
 * after every probe so one click never colours the next - a click that opened a menu or a
 * modal would otherwise cover whatever we press after it. Blocklisted labels are never
 * pressed, and a label is probed once per crawl no matter how many pages repeat it, which is
 * what keeps the shared chrome (a cart icon, a menu button) from being paid for on every page.
 *
 * Controls are addressed by their index in the selector's own DOM order, so a label that no
 * element renders as text is still reachable.
 */
async function probeNav(kit: BrowserToolkit, page: Page, origin: string, path: string, budget: ProbeBudget): Promise<Link[]> {
  const labels = await page.locator(NAV_PROBE_SELECTOR).evaluateAll(
    (els, attrs) => els.map((el) => (el.textContent ?? "").trim() || attrs.map((a) => el.getAttribute(a)?.trim()).find(Boolean) || ""),
    LABEL_ATTRS,
  );
  const found: Link[] = [];
  let probes = 0;
  for (let i = 0; i < labels.length; i++) {
    const text = labels[i];
    if (!text || budget.labels.has(text) || BLOCKLIST.test(text)) continue;
    if (probes >= MAX_PROBES_PER_PAGE || budget.spent >= MAX_PROBES_PER_CRAWL) break;
    budget.labels.add(text);
    budget.spent++;
    probes++;
    try {
      await page.locator(NAV_PROBE_SELECTOR).nth(i).click({ timeout: 2000 });
      await settle(page);
      const landed = page.url();
      if (landed.startsWith(origin) && pathOf(landed) !== path) found.push({ href: landed, text });
    } catch {
      /* not clickable right now: nothing to record */
    }
    // Always go back, even when the route never changed: the click may have left a menu or an
    // overlay open, and the next probe has to meet the page as it first loaded.
    await kit.act(page, { action: "goto", target: path }).catch(() => {});
    await settle(page);
  }
  return found;
}

/** Whether a page is showing a login form right now. The one signal every login screen shares. */
async function hasPasswordField(page: Page): Promise<boolean> {
  return (await page.locator("input[type=password]").count()) > 0;
}

const hasPasswordForm = (info: PageInfo): boolean => info.forms.some((f) => f.fields.some((x) => x.type === "password"));

async function pageInfo(kit: BrowserToolkit, page: Page, origin: string, probed?: ProbeBudget): Promise<PageInfo> {
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

/** Finds the first form with a password field, fills it, submits, and returns the steps taken, the
 *  login page's PageInfo (captured before credentials are filled, so it survives even if an authenticated
 *  visit later redirects away from the login path), and the route the login landed on - which is often
 *  the only door into the signed-in half of the app, since nothing links to it from outside. */
type LoginResult = { ok: true; steps: Step[]; loginPage: PageInfo; landedPath: string } | { ok: false; reason: string };

async function tryLogin(kit: BrowserToolkit, page: Page, loginPath: string, origin: string, creds: Credentials): Promise<LoginResult> {
  await kit.act(page, { action: "goto", target: loginPath });
  const loginPage = await pageInfo(kit, page, origin);
  const form = loginPage.forms.find((f) => f.fields.some((x) => x.type === "password"));
  if (!form) return { ok: false, reason: "no password field found on the page" };
  const pw = form.fields.find((x) => x.type === "password")!;
  const user = form.fields.find((x) => x !== pw && x.role === "textbox");
  if (!user) return { ok: false, reason: "found a password field but no username field alongside it" };
  if (!form.submit) return { ok: false, reason: "found username and password fields but no submit button" };
  const steps: Step[] = [
    { action: "goto", target: loginPath, intent: "open login page" },
    { action: "fill", role: "textbox", name: user.name, value: creds.username, intent: "enter username" },
    { action: "fill", role: "textbox", name: pw.name, value: creds.password, intent: "enter password" },
    { action: "click", role: "button", name: form.submit.name, value: undefined, intent: "submit login form" },
  ];
  for (const s of steps.slice(1)) if (!(await kit.act(page, s))) return { ok: false, reason: `step "${s.action} ${s.name}" could not be resolved on the page` };
  // The submit click already settled inside kit.act, so credentials that took have had every
  // chance to redirect by now; anything still showing a password field never left the login page.
  const landedPath = pathOf(page.url());
  if (landedPath === loginPath || (await hasPasswordField(page))) return { ok: false, reason: "still on the login page (or shown it again) after submitting" };
  return { ok: true, steps, loginPage, landedPath };
}

/** How many times a login is attempted before the crawl gives up and continues unauthenticated. */
export function loginRetryAttempts(): number {
  const raw = Number(process.env.QA_PILOT_LOGIN_RETRIES);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * Retries a login attempt with backoff before giving up on it.
 *
 * A single attempt conflates "these credentials are wrong" with "the app was slow, or had a
 * one-off hiccup, and would have worked a moment later" - against a real target the same
 * credentials that fail on attempt one can succeed cleanly on attempt two with no code change
 * in between. Retrying is what turns a marginal timing budget into a reliability property
 * instead of a coin flip, the same way `gotoWithRetry` already does for a single navigation.
 */
async function loginWithRetry(
  kit: BrowserToolkit,
  page: Page,
  loginPath: string,
  origin: string,
  creds: Credentials,
  opts: { attempts?: number; bus?: NodeDeps["bus"]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LoginResult> {
  const attempts = opts.attempts ?? loginRetryAttempts();
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: LoginResult = { ok: false, reason: "never attempted" };
  for (let i = 0; i < attempts; i++) {
    last = await tryLogin(kit, page, loginPath, origin, creds);
    if (last.ok) return last;
    if (i < attempts - 1) {
      opts.bus?.log("explorer", `login attempt ${i + 1}/${attempts} at ${loginPath} failed (${last.reason}); retrying`);
      await nap(1000 * (i + 1));
    }
  }
  return last;
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
  const candidate = homeLinks.map((h) => pathOf(h.href)).find((p) => /log-?in|sign-?in/i.test(p));
  // A demo app often has no "Log in" link to follow because the landing page *is* the login form.
  // Without this the crawl never signs in, and everything behind the wall goes unexplored.
  if (candidate) loginPath = candidate;
  else if (await hasPasswordField(page)) loginPath = pathOf(page.url());
  // Pages reachable only from the unauthenticated nav (e.g. "/register") won't be linked once we're
  // logged in, so seed the queue with everything visible before login happens - filtered the same way
  // as the main loop (same-origin, not blocklisted, not a logout link).
  const preLoginPaths = filterLinks(homeLinks, origin);
  let landedPath: string | null = null;
  if (loginPath && opts.credentials) {
    const result = await loginWithRetry(kit, page, loginPath, origin, opts.credentials, { bus: opts.bus });
    if (result.ok) {
      loginSteps = result.steps;
      pages[loginPath] = result.loginPage;
      landedPath = result.landedPath;
      opts.bus?.log("explorer", `logged in via ${loginPath}, landed on ${landedPath}`);
    } else opts.bus?.log("explorer", `login at ${loginPath} did not succeed after ${loginRetryAttempts()} attempt(s): ${result.reason}`);
  } else if (opts.credentials) {
    // Credentials were supplied and never used. Silence here reads as a successful crawl of
    // a tiny app, when in fact everything behind the sign-in was missed.
    opts.bus?.log("explorer", `credentials were provided but no login form was found; crawling unauthenticated`);
  }

  const queue: { path: string; depth: number }[] = [{ path: "/", depth: 0 }];
  // Where the login dropped us is the entrance to the signed-in half of the app, and usually
  // nothing outside the wall links to it.
  if (landedPath) queue.push({ path: landedPath, depth: 0 });
  for (const p of preLoginPaths) queue.push({ path: p, depth: 1 });
  if (loginPath) queue.push({ path: loginPath, depth: 1 });
  const seen = new Set<string>();
  const probed = newProbeBudget();
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
    // A landing page's content is only ever recorded under its own path, and only once, which
    // keeps `pages` bounded to at most maxPages entries. The one exception is a visit that
    // bounced to the login page. An anonymous crawl meets every gated route exactly this way,
    // and the bounce is itself the gating signal - so the *requested* path is recorded as a
    // gated route whose content is unknown, rather than discarded. Discarding it filed
    // /checkout, /orders and /account under /login on a crawl run without credentials: the
    // planner never saw them and the authz coverage check had nothing to score. The login
    // page itself is still recorded when it is visited as itself (it is always queued).
    const bouncedToLogin = finalPath !== path && loginPath !== null && finalPath === loginPath;
    if (bouncedToLogin) {
      if (!(path in pages)) pages[path] = { url: origin + path, path, title: "", forms: [], buttons: [], links: [], gated: true, snapshot: "" };
    } else if (!(finalPath in pages)) pages[finalPath] = info;
    // The structured payload is what the Sources screen counts pages with; the message
    // stays human-readable for the feed. Never make the UI parse the sentence.
    if (bouncedToLogin) {
      opts.bus?.log("explorer", `visited ${path}: bounced to ${finalPath}, recorded as gated`, { visited: path, forms: 0, buttons: 0, gated: true });
    } else {
      opts.bus?.log("explorer", `visited ${finalPath} (${info.forms.length} forms, ${info.buttons.length} buttons)`, {
        visited: finalPath, forms: info.forms.length, buttons: info.buttons.length,
      });
    }
    for (const p of filterLinks(info.links, origin)) {
      if (!seen.has(p)) queue.push({ path: p, depth: depth + 1 });
    }
  }
  await page.close();

  // Gating: revisit each path unauthenticated. A route is gated either because the visit is
  // bounced to the login page, or because the app answers in place with the login screen at the
  // same URL - which is what a demo app usually does. A page that shows a password field to
  // everyone (the login page itself, a register page) is not gated by that second rule.
  const anon = await kit.newContext();
  const anonPage = await anon.newPage();
  for (const path of Object.keys(pages)) {
    try {
      // Retried, because the catch below reads a failure as "not gated" - a wrong answer
      // rather than a missing one, which would silently drop this route's authz flows.
      await gotoWithRetry(anonPage, origin + path);
      await settle(anonPage);
      const landed = pathOf(anonPage.url());
      const bounced = landed !== path && loginPath !== null && landed === loginPath;
      const blockedInPlace = landed === path && !hasPasswordForm(pages[path]) && (await hasPasswordField(anonPage));
      pages[path].gated = bounced || blockedInPlace;
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
