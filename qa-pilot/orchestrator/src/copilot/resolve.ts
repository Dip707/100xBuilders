import type { ChatScope, RunRecord, RunStatus, Store } from "../store/types.js";

/** Statuses a copilot may act on. A run still going or parked at review is never rerun. */
export const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "partial", "failed", "interrupted"]);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Two URLs name the same target when their origins match; paths and trailing slashes do not matter. */
export function sameTarget(a: string, b: string): boolean {
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}

/**
 * Which run a message is about. Only the caller's own runs are ever considered, so a scope
 * or a message naming somebody else's run id resolves to nothing rather than to their run.
 */
export async function resolveRun(store: Store, userId: string, scope: ChatScope, text: string): Promise<RunRecord | null> {
  const runs = await store.listRuns(userId);
  const finished = runs.filter((r) => FINISHED.has(r.status));

  // A run id typed into the message. Ids contain hyphens and dots, so match whole tokens.
  const tokens = new Set(text.split(/[\s,;:!?()"']+/).filter(Boolean));
  const named = runs.find((r) => tokens.has(r.id));
  if (named) return named;

  if (scope.runId) return runs.find((r) => r.id === scope.runId) ?? null;

  if (scope.url) {
    const url = scope.url;
    return finished.find((r) => sameTarget(r.url, url)) ?? null;
  }

  return finished[0] ?? null;
}
