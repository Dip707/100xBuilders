import type { MiddlewareHandler } from "hono";
import type { Store, User } from "../store/types.js";
import { readSessionCookie, hashToken } from "./session.js";

export type AuthEnv = { Variables: { user: User } };

/**
 * Every authenticated request would otherwise cost an Atlas round trip, and the live run
 * view fetches one screenshot per exploration step through an authenticated route. This
 * cache makes a burst of those cost one lookup instead of dozens. Atlas stays the source
 * of truth: entries live 30 seconds, and logout evicts immediately so it takes effect at
 * once rather than after the TTL.
 */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;

type Entry = { user: User; cachedAt: number };
const cache = new Map<string, Entry>();

export function evictSession(tokenHash: string): void {
  cache.delete(tokenHash);
}

/** Test seam: the cache is module state, so a test that asserts on lookup counts must start clean. */
export function clearSessionCache(): void {
  cache.clear();
}

function fromCache(tokenHash: string): User | null {
  const hit = cache.get(tokenHash);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > CACHE_TTL_MS) { cache.delete(tokenHash); return null; }
  return hit.user;
}

function toCache(tokenHash: string, user: User): void {
  // Map preserves insertion order, so the first key is the oldest entry.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(tokenHash, { user, cachedAt: Date.now() });
}

export function requireUser(store: Store): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const tokenHash = hashToken(token);

    const cached = fromCache(tokenHash);
    if (cached) { c.set("user", cached); return next(); }

    const session = await store.findSession(tokenHash);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    const user = await store.findUserById(session.userId);
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    toCache(tokenHash, user);
    c.set("user", user);
    return next();
  };
}
