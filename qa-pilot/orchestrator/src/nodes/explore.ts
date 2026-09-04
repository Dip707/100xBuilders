import type { Page } from "playwright";
import { BrowserToolkit } from "../browser/toolkit.js";
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

async function pageInfo(kit: BrowserToolkit, page: Page, origin: string): Promise<PageInfo> {
  const url = page.url();
  const path = new URL(url).pathname;
  const snapshot = await kit.snapshot(page);
  const nodes = parseSnapshot(snapshot);
  const links = await page.locator("a[href]").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim() })));
  return {
    url,
    path,
    title: await page.title(),
    forms: await extractForms(page, path),
    buttons: nodes.filter((n) => n.role === "button").map((n) => ({ role: "button", name: n.name })),
    links: links.filter((l) => l.href.startsWith(origin)),
    gated: false,
    snapshot,
  };
}

/** Keeps only same-origin links whose text isn't blocklisted and whose path isn't a logout link, returning pathnames. */
export function filterLinks(links: { href: string; text: string }[], origin: string): string[] {
  return links
    .filter((l) => l.href.startsWith(origin))
    .filter((l) => !BLOCKLIST.test(l.text))
    .filter((l) => !/logout|signout/i.test(new URL(l.href).pathname))
    .map((l) => new URL(l.href).pathname);
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
  return new URL(page.url()).pathname === loginPath ? null : { steps, loginPage };
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
  const homeLinks = await page.locator("a[href]").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim() })));
  const candidate = homeLinks.map((h) => new URL(h.href).pathname).find((p) => /log-?in|sign-?in/i.test(p));
  if (candidate) loginPath = candidate;
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
  }

  const queue: { path: string; depth: number }[] = [{ path: "/", depth: 0 }];
  for (const p of preLoginPaths) queue.push({ path: p, depth: 1 });
  if (loginPath) queue.push({ path: loginPath, depth: 1 });
  const seen = new Set<string>();
  while (queue.length && Object.keys(pages).length < maxPages) {
    const { path, depth } = queue.shift()!;
    if (seen.has(path) || depth > maxDepth) continue;
    seen.add(path);
    try {
      await kit.act(page, { action: "goto", target: path });
    } catch {
      continue;
    }
    const finalPath = new URL(page.url()).pathname;
    let info: PageInfo;
    try {
      info = await pageInfo(kit, page, origin);
    } catch (e) {
      const message = (e as Error).message.split("\n")[0];
      opts.bus?.log("explorer", `extraction failed for ${path}: ${message}`);
      continue;
    }
    // Only the landing page's own path is ever recorded (never an alias under the pre-redirect `path`),
    // and only once - this keeps `pages` bounded to at most maxPages entries.
    if (!(finalPath in pages)) pages[finalPath] = info;
    opts.bus?.log("explorer", `visited ${finalPath} (${info.forms.length} forms, ${info.buttons.length} buttons)`);
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
      await anonPage.goto(origin + path, { waitUntil: "domcontentloaded" });
      const landed = new URL(anonPage.url()).pathname;
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
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, agent: "explorer", screenshotDir: outputDir(state.runId) + "traces/explore" });
  try {
    const siteMap = await crawl(kit, { credentials: state.credentials, bus: deps.bus });
    deps.bus.decision({ node: "explore", reason: `discovered ${Object.keys(siteMap.pages).length} pages, ${Object.values(siteMap.pages).filter((p) => p.gated).length} gated`, evidence: Object.keys(siteMap.pages), next: "plan", at: now() });
    deps.bus.emit({ type: "node_end", node: "explore" });
    return { siteMap };
  } finally {
    await kit.close();
  }
}
