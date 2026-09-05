import { z } from "zod";
import type { Page } from "playwright";
import type { BrowserToolkit } from "../browser/toolkit.js";
import type { EventBus } from "../events.js";
import type { LlmClient } from "../llm/client.js";
import { StepSchema, type Credentials, type SiteMap, type Step } from "../state.js";
import { BLOCKLIST } from "./deps.js";
import { markGated, pageInfo, pathOf, settle } from "./explore.js";

/**
 * The tokens the agent writes into credential fields. The model never sees a password: it
 * asks for "the username" and "the password" by name, and the harness substitutes the real
 * values right before the fill, so neither the prompt nor the event log ever carries them.
 */
export const USERNAME_TOKEN = "{{USERNAME}}";
export const PASSWORD_TOKEN = "{{PASSWORD}}";

export const AgentDecisionSchema = z.object({
  reasoning: z.string(),
  done: z.boolean(),
  action: StepSchema.optional(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** How many LLM-chosen actions the agent may take per run. Every one is an LLM call. */
export const DEFAULT_AGENT_STEPS = 12;
export function agentStepBudget(): number {
  const raw = process.env.QA_PILOT_EXPLORE_AGENT_STEPS;
  if (raw === undefined || raw === "") return DEFAULT_AGENT_STEPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_AGENT_STEPS;
}

/** Snapshots past this size are cut: the model needs the page's shape, not every product card. */
const MAX_SNAPSHOT_CHARS = 7000;
const MAX_HISTORY = 15;

/** Replaces the credential tokens in a step. Throws when a token is used without credentials. */
export function materialize(step: Step, creds?: Credentials): Step {
  if (!step.value) return step;
  const usesToken = step.value.includes(USERNAME_TOKEN) || step.value.includes(PASSWORD_TOKEN);
  if (!usesToken) return step;
  if (!creds) throw new Error("credential token used but no credentials were provided");
  const value = step.value.split(USERNAME_TOKEN).join(creds.username).split(PASSWORD_TOKEN).join(creds.password);
  return { ...step, value };
}

export function describeStep(step: Step): string {
  if (step.action === "goto") return `goto ${step.target ?? "/"}`;
  const target = `${step.role ?? ""} "${step.name ?? ""}"`.trim();
  // Values are never echoed: a fill may carry a credential.
  return step.value ? `${step.action} ${target} (with a value)` : `${step.action} ${target}`;
}

export function buildAgentInput(ctx: {
  url: string;
  intent?: string;
  hasCredentials: boolean;
  siteMap: SiteMap;
  history: string[];
  snapshot: string;
}): string {
  const known = Object.values(ctx.siteMap.pages)
    .map((p) => `${p.path}${p.gated ? " (gated)" : ""} - ${p.forms.length} forms, ${p.buttons.length} buttons`)
    .join("\n");
  const snapshot = ctx.snapshot.length > MAX_SNAPSHOT_CHARS ? ctx.snapshot.slice(0, MAX_SNAPSHOT_CHARS) + "\n... (truncated)" : ctx.snapshot;
  return [
    `Current URL: ${ctx.url}`,
    ctx.intent ? `Operator intent: ${ctx.intent}` : "Operator intent: none given",
    `Credentials available: ${ctx.hasCredentials ? "yes (use the tokens)" : "no"}`,
    `Login page: ${ctx.siteMap.loginPath ?? "unknown"}; signed in already: ${ctx.siteMap.loginSteps.length ? "yes" : "no"}`,
    `Known pages (${Object.keys(ctx.siteMap.pages).length}):\n${known || "(none)"}`,
    `Actions so far:\n${ctx.history.length ? ctx.history.slice(-MAX_HISTORY).map((h, i) => `${i + 1}. ${h}`).join("\n") : "(none)"}`,
    `Accessibility snapshot of the current page:\n${snapshot}`,
  ].join("\n\n");
}

/**
 * Strips the credential values out of a snapshot. Once a field is filled its value is part of
 * the accessibility tree, so without this the password reaches the model on the very next
 * step; it is replaced by the same token the model wrote, which keeps the picture coherent.
 */
export function redact(snapshot: string, creds?: Credentials): string {
  if (!creds) return snapshot;
  let out = snapshot;
  if (creds.password) out = out.split(creds.password).join(PASSWORD_TOKEN);
  if (creds.username) out = out.split(creds.username).join(USERNAME_TOKEN);
  return out;
}

async function hasPasswordField(page: Page): Promise<boolean> {
  return (await page.locator("input[type=password]").count()) > 0;
}

/**
 * Lets the model drive the browser for a bounded number of steps, adding every page it lands
 * on to the site map. Pages it discovers get the same gating check as crawled ones. When the
 * agent fills the password token and the next submit leaves the login page, the sequence is
 * recorded as the site map's login steps, exactly as the heuristic login would have.
 */
export async function exploreWithAgent(
  kit: BrowserToolkit,
  siteMap: SiteMap,
  opts: { llm: LlmClient; bus?: EventBus; credentials?: Credentials; intent?: string; maxSteps?: number },
): Promise<{ steps: number; discovered: string[] }> {
  const maxSteps = opts.maxSteps ?? DEFAULT_AGENT_STEPS;
  const origin = new URL(kit.baseUrl).origin;
  const discovered: string[] = [];
  const history: string[] = [];
  if (maxSteps <= 0) return { steps: 0, discovered };

  const page = await kit.newPage();
  // The steps taken since the last goto, with real values. Becomes the login recipe when a
  // password fill followed by a submit leaves the login page.
  let sinceGoto: Step[] = [];
  let lastGoto: string = pathOf(kit.baseUrl);
  let filledPassword = false;
  let steps = 0;
  try {
    await kit.act(page, { action: "goto", target: lastGoto });
    await settle(page);
    for (; steps < maxSteps; steps++) {
      const snapshot = redact(await kit.snapshot(page).catch(() => ""), opts.credentials);
      const decision = await opts.llm.complete({
        prompt: "explore-agent",
        input: buildAgentInput({ url: page.url(), intent: opts.intent, hasCredentials: Boolean(opts.credentials), siteMap, history, snapshot }),
        schema: AgentDecisionSchema,
        effort: "low",
        maxTokens: 2000,
      });
      opts.bus?.log("explorer", `agent: ${decision.reasoning}`, { agent_step: steps + 1, done: decision.done });
      if (decision.done || !decision.action) break;
      const step = decision.action;
      if (step.action !== "goto" && BLOCKLIST.test(step.name ?? "")) {
        history.push(`${describeStep(step)} -> refused: destructive control`);
        opts.bus?.log("explorer", `agent refused: ${describeStep(step)} is destructive`);
        continue;
      }
      let real: Step;
      try {
        real = materialize(step, opts.credentials);
      } catch {
        history.push(`${describeStep(step)} -> refused: no credentials available`);
        continue;
      }
      const before = pathOf(page.url());
      const hadPassword = await hasPasswordField(page).catch(() => false);
      const done = await kit.act(page, real).catch(() => null);
      if (!done) {
        history.push(`${describeStep(step)} -> failed: element not found or not actionable`);
        continue;
      }
      await settle(page);
      const after = pathOf(page.url());
      if (real.action === "goto") {
        sinceGoto = [];
        lastGoto = real.target ?? "/";
        filledPassword = false;
      } else {
        sinceGoto.push(real);
        if (real.action === "fill" && step.value?.includes(PASSWORD_TOKEN)) filledPassword = true;
      }
      if (!page.url().startsWith(origin)) {
        history.push(`${describeStep(step)} -> left the app (${page.url()}), going back`);
        await kit.act(page, { action: "goto", target: lastGoto }).catch(() => {});
        continue;
      }
      // A submit that took us off a page with a password field, after the password was filled,
      // is a sign-in. Record it once; the planner and the runner replay it for gated flows.
      if (filledPassword && hadPassword && after !== before && !(await hasPasswordField(page).catch(() => true)) && siteMap.loginSteps.length === 0) {
        siteMap.loginSteps = [{ action: "goto", target: before, intent: "open login page" }, ...sinceGoto];
        if (!siteMap.loginPath) siteMap.loginPath = before;
        opts.bus?.log("explorer", `agent signed in via ${before}, landed on ${after}`);
      }
      if (!(after in siteMap.pages)) {
        try {
          const info = await pageInfo(kit, page, origin);
          siteMap.pages[after] = info;
          discovered.push(after);
          opts.bus?.log("explorer", `visited ${after} (${info.forms.length} forms, ${info.buttons.length} buttons)`, {
            visited: after, forms: info.forms.length, buttons: info.buttons.length, by: "agent",
          });
        } catch (e) {
          opts.bus?.log("explorer", `extraction failed for ${after}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      history.push(`${describeStep(step)} -> now at ${after}${after === before ? " (unchanged)" : ""}`);
    }
  } finally {
    await page.close().catch(() => {});
  }
  if (discovered.length) {
    const fresh = Object.fromEntries(discovered.map((p) => [p, siteMap.pages[p]]));
    await markGated(kit, origin, siteMap.loginPath, fresh);
  }
  return { steps, discovered };
}
