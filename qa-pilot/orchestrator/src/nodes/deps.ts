import type { EventBus } from "../events.js";
import type { LlmClient } from "../llm/client.js";

export type NodeDeps = { bus: EventBus; llm: LlmClient; headless?: boolean };
/** Labels the crawler must never click. The probe now presses any button outside a form, so
 *  this is the only thing standing between an exploratory click and a control that throws the
 *  app's state away. */
export const BLOCKLIST = /\b(delete|remove|log ?out|sign ?out|destroy|clear|reset|wipe|erase|revoke|cancel ?(account|subscription))\b/i;
export const now = () => new Date().toISOString();
