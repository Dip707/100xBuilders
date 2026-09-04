import { randomBytes, createHash } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";

export const SESSION_COOKIE = "qa_pilot_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 bytes of randomness, base64url so it needs no escaping in a cookie value. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Sessions are stored by digest, never in plaintext, so a dump of the sessions
 * collection cannot be replayed as a set of live logins.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * `secure` is decided from the request host rather than NODE_ENV: the dev setup is plain
 * http on localhost, where a Secure cookie would simply never be stored, and any other
 * host is assumed to be served over https.
 */
function isLocalhost(c: Context): boolean {
  const host = new URL(c.req.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: !isLocalhost(c),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: !isLocalhost(c) });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
