import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SESSION_COOKIE, SESSION_TTL_MS, mintToken, hashToken, setSessionCookie, clearSessionCookie, readSessionCookie } from "../src/auth/session.js";

describe("session", () => {
  it("mints unguessable tokens and hashes them stably", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);      // 32 bytes base64url
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);            // url safe, no padding
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);   // sha-256 hex
    expect(hashToken(a)).not.toContain(a);
  });

  it("expires in 30 days", () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("sets an httpOnly Lax cookie, insecure on localhost and secure elsewhere", async () => {
    const app = new Hono();
    app.get("/set", (c) => { setSessionCookie(c, "tok-123"); return c.text("ok"); });

    const local = await app.request("http://localhost:4000/set");
    const localCookie = local.headers.get("set-cookie") ?? "";
    expect(localCookie).toContain(`${SESSION_COOKIE}=tok-123`);
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Lax");
    expect(localCookie).toContain("Path=/");
    expect(localCookie).not.toContain("Secure");

    const remote = await app.request("https://qa.example.com/set");
    expect(remote.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  it("reads the cookie back and clears it", async () => {
    const app = new Hono();
    app.get("/read", (c) => c.text(readSessionCookie(c) ?? "none"));
    app.get("/clear", (c) => { clearSessionCookie(c); return c.text("ok"); });

    const read = await app.request("http://localhost:4000/read", { headers: { cookie: `${SESSION_COOKIE}=abc` } });
    expect(await read.text()).toBe("abc");
    expect(await (await app.request("http://localhost:4000/read")).text()).toBe("none");

    const cleared = await app.request("http://localhost:4000/clear");
    expect(cleared.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
