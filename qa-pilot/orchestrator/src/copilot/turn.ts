import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import type { ChatMessage } from "../store/types.js";
import { failedIds, renderCatalogue, type Catalogue } from "./catalogue.js";

/** How many transcript messages the model sees. The catalogue carries the state, so older turns only cost tokens. */
export const CONTEXT_MESSAGES = 12;

export type CopilotAction = "rerun" | "answer" | "clarify";

export const CopilotTurnSchema = z.object({
  reply: z.string(),
  action: z.enum(["rerun", "answer", "clarify"]),
  testIds: z.array(z.string()).default([]),
  /** First turn only: a short name for the chat, shown in the chats dropdown. */
  title: z.string().optional(),
});

export type CopilotDecision = { reply: string; action: CopilotAction; testIds: string[]; title?: string };

export function turnInput(args: { catalogue: Catalogue; messages: ChatMessage[]; needsTitle?: boolean }): string {
  const lines = ["RUN CATALOGUE", renderCatalogue(args.catalogue), "", "CONVERSATION"];
  for (const m of args.messages.slice(-CONTEXT_MESSAGES)) lines.push(`${m.role}: ${m.text}`);
  if (args.needsTitle) lines.push("", "NAME THIS CHAT: this is the first turn, so also return a short title of three to five words.");
  return lines.join("\n");
}

export async function copilotTurn(
  llm: LlmClient,
  args: { catalogue: Catalogue; messages: ChatMessage[]; needsTitle?: boolean },
): Promise<CopilotDecision> {
  const out = await llm.complete({
    prompt: "copilot-turn",
    input: turnInput(args),
    schema: CopilotTurnSchema,
    // A turn is a short reply and a list of ids, in front of someone waiting for it.
    effort: "low",
    maxTokens: 1500,
  });
  const decision: CopilotDecision = { reply: out.reply, action: out.action, testIds: out.testIds };
  if (out.title) decision.title = out.title;
  return decision;
}

/**
 * The boundary between the model and the runner. Only ids that exist in the catalogue and
 * have a spec on disk survive, in catalogue order. A rerun left with nothing is downgraded to
 * a clarification whose text is written here, not by the model, so the transcript can never
 * claim a rerun that was not scheduled.
 */
export function validateSelection(decision: CopilotDecision, catalogue: Catalogue): CopilotDecision {
  if (decision.action !== "rerun") return { ...decision, testIds: [] };
  const wanted = new Set(decision.testIds);
  const testIds = catalogue.tests.filter((t) => t.generated && wanted.has(t.id)).map((t) => t.id);
  if (testIds.length > 0) return { ...decision, testIds };

  const failed = failedIds(catalogue);
  const asked = decision.testIds.length ? `I could not find ${decision.testIds.join(", ")} in run ${catalogue.runId}. ` : "";
  const reply = failed.length
    ? `${asked}The tests that failed in this run are ${failed.join(", ")}. Which of them should I rerun?`
    : `${asked}In run ${catalogue.runId} every generated test passed, so there is nothing failed to rerun. Name the tests you want run again.`;
  return { reply, action: "clarify", testIds: [], ...(decision.title ? { title: decision.title } : {}) };
}
