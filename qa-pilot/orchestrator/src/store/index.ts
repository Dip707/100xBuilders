import "../env.js";
import { mongoStore } from "./mongo.js";
import type { Store } from "./types.js";

let shared: Promise<Store> | undefined;

/** The process-wide store, memoised so the API and the CLI share one connection pool. */
export function defaultStore(): Promise<Store> {
  shared ??= mongoStore();
  return shared;
}

export * from "./types.js";
export { memoryStore } from "./memory.js";
export { mongoStore } from "./mongo.js";
