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
 * `secure` is decided from the request's URL scheme, not its Host header: a Host header is
 * client-supplied and trivially spoofable (`Host: localhost` on a real deployment would have
 * downgraded the cookie under a hostname check), while the scheme the request actually arrived
 * over is not. Behaviour on `http://localhost` is unchanged by this: a `Secure` cookie is never
 * stored over plain http regardless of hostname, so it still comes out insecure there. It is
 * strictly better for a plain-http LAN demo such as `http://192.168.1.5:4000`, where a hostname
 * check would set `Secure` and silently break login since the browser would refuse to store the
 * cookie at all.
 */
function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: isHttps(c),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isHttps(c) });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
