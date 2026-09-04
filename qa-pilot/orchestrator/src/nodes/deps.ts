import type { EventBus } from "../events.js";
import type { LlmClient } from "../llm/client.js";

export type NodeDeps = { bus: EventBus; llm: LlmClient; headless?: boolean };
export const BLOCKLIST = /\b(delete|remove|log ?out|sign ?out|destroy|clear)\b/i;
export const now = () => new Date().toISOString();
