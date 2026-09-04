const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60_000;

type Window = { count: number; startedAt: number };
const windows = new Map<string, Window>();

/**
 * A fixed window per lowercased email. Deliberately in-process and deliberately simple:
 * this is a self-hosted single-process tool, so a distributed limiter would be ceremony.
 * Without any limit at all the login endpoint is a free brute-force oracle.
 */
export function checkThrottle(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || now - current.startedAt > WINDOW_MS) {
    windows.set(key, { count: 1, startedAt: now });
    return { ok: true };
  }
  if (current.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + WINDOW_MS - now) / 1000)) };
  }
  current.count++;
  return { ok: true };
}

export function clearThrottle(key: string): void {
  windows.delete(key);
}

export function resetThrottleForTests(): void {
  windows.clear();
}
