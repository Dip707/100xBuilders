import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import type { ChatMessage, RunDraft } from "../store/types.js";
import { DEFAULT_MAX_FLOWS } from "../state.js";

/**
 * How many transcript messages the model sees. The draft carries the accumulated state, so
 * older turns cost tokens without adding information.
 */
export const CONTEXT_MESSAGES = 12;

/** Characters of the PRD the model is shown. It only needs to know what kind of document arrived. */
const PRD_HEAD = 600;

const NEEDS = ["url", "intent", "prd", "credentials"] as const;
export type Need = (typeof NEEDS)[number];

/**
 * The fields a turn may write. Deliberately excludes prdText - only the attach path in the
 * browser sets that - and excludes credentials entirely, which are never in the model's
 * vocabulary in either direction.
 */
const PatchSchema = z.object({
  url: z.string().optional(),
  intent: z.string().optional(),
  requiresSignIn: z.boolean().optional(),
  maxFlows: z.number().optional(),
  budget: z.object({ maxLlmCalls: z.number().optional(), maxMinutes: z.number().optional() }).optional(),
  reviewPlan: z.boolean().optional(),
});

export const ChatTurnSchema = z.object({
  /** The text the panel renders as the assistant's message. */
  reply: z.string(),
  /** Fields to write into the form. Absent keys leave the field as it is. */
  patch: PatchSchema.default({}),
  /** What the turn still wants, which the panel turns into an inline prompt or widget. */
  needs: z.array(z.enum(NEEDS)).default([]),
  /** First turn only: a short name for the chat, shown in the chats dropdown. */
  title: z.string().optional(),
});

export type ChatTurn = { reply: string; patch: RunDraft; needs: Need[]; title?: string };

/**
 * The draft as the browser may send it. Zod strips keys it does not declare, so a snapshot
 * that carries the target app's username and password - which the page holds in its own
 * state while the credential inputs are on screen - cannot reach the stored transcript.
 */
export const RunDraftSchema = z.object({
  url: z.string().optional(),
  intent: z.string().optional(),
  prdText: z.string().optional(),
  prdName: z.string().optional(),
  requiresSignIn: z.boolean().optional(),
  maxFlows: z.number().int().positive().optional(),
  budget: z.object({ maxLlmCalls: z.number().int().positive().optional(), maxMinutes: z.number().int().positive().optional() }).optional(),
  reviewPlan: z.boolean().optional(),
});

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : undefined;
}

/**
 * A bare host is what people type and what a model tends to echo back, but the form's
 * validator - and `RunInputSchema` behind it - only accept a parseable http(s) URL, so the
 * scheme is added here. Anything still unparseable is dropped rather than written: an
 * invalid string in the URL field looks like the agent filled it in correctly.
 */
function normaliseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // Returned as typed rather than as `parsed.href`, which would append a trailing slash to
  // an origin-only URL and make the field disagree with what the user sees in the chat.
  return withScheme;
}

/**
 * Picks the draft fields out of whatever the model returned, field by field. Written as an
 * explicit allow-list rather than a schema strip so that a key the model was told never to
 * emit - `password`, `credentials`, `prdText` - cannot reach form state or the store even if
 * a turn invents one.
 */
export function normalisePatch(raw: unknown): RunDraft {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: RunDraft = {};

  const url = normaliseUrl(p.url);
  if (url) out.url = url;

  // An empty string would blank a field the user had already filled, so only real text writes.
  const intent = typeof p.intent === "string" ? p.intent.trim() : "";
  if (intent) out.intent = intent;

  if (typeof p.requiresSignIn === "boolean") out.requiresSignIn = p.requiresSignIn;
  if (typeof p.reviewPlan === "boolean") out.reviewPlan = p.reviewPlan;

  const maxFlows = positiveInt(p.maxFlows);
  if (maxFlows !== undefined) out.maxFlows = maxFlows;

  if (p.budget && typeof p.budget === "object") {
    const b = p.budget as Record<string, unknown>;
    const maxLlmCalls = positiveInt(b.maxLlmCalls);
    const maxMinutes = positiveInt(b.maxMinutes);
    const budget: NonNullable<RunDraft["budget"]> = {};
    if (maxLlmCalls !== undefined) budget.maxLlmCalls = maxLlmCalls;
    if (maxMinutes !== undefined) budget.maxMinutes = maxMinutes;
    if (Object.keys(budget).length > 0) out.budget = budget;
  }

  return out;
}

function prdLine(draft: RunDraft): string {
  if (!draft.prdText) return "(none attached)";
  const bytes = Buffer.byteLength(draft.prdText, "utf8");
  const head = draft.prdText.slice(0, PRD_HEAD).replace(/\s+/g, " ").trim();
  return `${draft.prdName ?? "pasted text"}, ${bytes} bytes, starts: ${head}`;
}

/**
 * The user turn. Built field by field from the draft - never `JSON.stringify(draft)` - so a
 * stray key cannot ride along into the prompt, and the PRD is summarised rather than sent.
 */
export function turnInput(args: { draft: RunDraft; messages: ChatMessage[]; needsTitle?: boolean }): string {
  const d = args.draft;
  const lines = [
    "CURRENT DRAFT",
    `url: ${d.url ?? "(empty)"}`,
    `intent: ${d.intent ?? "(empty)"}`,
    `prd: ${prdLine(d)}`,
    `requiresSignIn: ${d.requiresSignIn ?? false}`,
    `reviewPlan: ${d.reviewPlan ?? false}`,
    `maxFlows: ${d.maxFlows ?? DEFAULT_MAX_FLOWS}`,
    `budget: ${d.budget?.maxLlmCalls ?? 200} LLM calls, ${d.budget?.maxMinutes ?? 40} minutes`,
    "",
    "CONVERSATION",
  ];
  for (const m of args.messages.slice(-CONTEXT_MESSAGES)) lines.push(`${m.role}: ${m.text}`);
  if (args.needsTitle) {
    lines.push("", "NAME THIS CHAT: this is the first turn, so also return a short title of three to five words.");
  }
  return lines.join("\n");
}

export async function chatTurn(
  llm: LlmClient,
  args: { draft: RunDraft; messages: ChatMessage[]; needsTitle?: boolean },
): Promise<ChatTurn> {
  const out = await llm.complete({
    prompt: "chat-intake",
    input: turnInput(args),
    schema: ChatTurnSchema,
    // A turn is one short reply and a handful of fields, and it is in front of someone
    // waiting for it. High effort would buy nothing here and cost seconds.
    effort: "low",
    maxTokens: 1500,
  });
  const turn: ChatTurn = { reply: out.reply, patch: normalisePatch(out.patch), needs: out.needs };
  if (out.title) turn.title = out.title;
  return turn;
}
