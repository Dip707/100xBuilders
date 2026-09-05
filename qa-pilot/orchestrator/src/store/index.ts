import "../env.js";
import { memoryStore } from "./memory.js";
import { mongoStore } from "./mongo.js";
import type { Store } from "./types.js";

let shared: Promise<Store> | undefined;

/** Whether a Mongo connection string is configured, under either accepted name. */
export function mongoConfigured(): boolean {
  return Boolean(process.env.QA_PILOT_MONGO_URL ?? process.env.MONGO_URI);
}

/** Which store `defaultStore()` will build, and why. Exported so the API can log it once. */
export function storeChoice(): { kind: "mongo" | "memory"; reason: string } {
  const forced = process.env.QA_PILOT_STORE;
  if (forced === "memory") return { kind: "memory", reason: "QA_PILOT_STORE=memory" };
  if (forced === "mongo") return { kind: "mongo", reason: "QA_PILOT_STORE=mongo" };
  if (mongoConfigured()) return { kind: "mongo", reason: "QA_PILOT_MONGO_URL is set" };
  return { kind: "memory", reason: "no QA_PILOT_MONGO_URL set" };
}

/**
 * The process-wide store, memoised so the API and the CLI share one connection pool.
 *
 * Mongo stays the default whenever it is configured, because runs and accounts have to
 * survive an API restart. But requiring an Atlas string just to start the API made a fresh
 * clone unrunnable - `npm run api` died before it bound a port - so with no connection
 * string the process falls back to the in-memory store, which passes the same contract
 * test in `test/store.test.ts`. The fallback is announced rather than silent, because its
 * cost is real: everything is lost when the process exits, and a single-test re-run after
 * a restart will not find its run.
 *
 * `QA_PILOT_STORE=mongo` forces the old behaviour, so a deployment that must not silently
 * degrade to memory can still fail loudly on a missing connection string.
 */
export function defaultStore(): Promise<Store> {
  shared ??= (async () => {
    const { kind, reason } = storeChoice();
    if (kind === "memory") {
      console.warn(`qa-pilot: using the in-memory store (${reason}); runs and accounts are lost when this process exits.`);
      return memoryStore();
    }
    return mongoStore();
  })();
  return shared;
}

export * from "./types.js";
export { memoryStore } from "./memory.js";
export { mongoStore } from "./mongo.js";
