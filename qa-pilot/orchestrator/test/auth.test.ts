import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { authRoutes } from "../src/auth/routes.js";
import { resetThrottleForTests } from "../src/auth/throttle.js";
import { clearSessionCache } from "../src/auth/middleware.js";
import { SESSION_COOKIE } from "../src/auth/session.js";

const ORIGIN = "http://localhost:4000";
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** Pulls the session cookie value out of a Set-Cookie header so later requests can send it. */
function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const matched = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(raw);
  return `${SESSION_COOKIE}=${matched?.[1] ?? ""}`;
}

function app(store: Store) {
  const outer = new Hono();
  outer.route("/auth", authRoutes(store));
  return outer;
}

describe("auth routes", () => {
  let store: Store;
  beforeEach(() => { store = memoryStore(); resetThrottleForTests(); clearSessionCache(); });

  it("signs up, sets a session cookie, and answers /auth/me", async () => {
    const a = app(store);
    const res = await a.request(`${ORIGIN}/auth/signup`, json({ email: "New@Example.com", password: "demo1234" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ user: { id: expect.any(String), email: "new@example.com", createdAt: expect.any(String) } });

    const me = await a.request(`${ORIGIN}/auth/me`, { headers: { cookie: cookieFrom(res) } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("new@example.com");
  });

  it("never returns the password hash", async () => {
    const res = await app(store).request(`${ORIGIN}/auth/signup`, json({ email: "a@example.com", password: "demo1234" }));
    expect(JSON.stringify(await res.json())).not.toContain("scrypt");
  });

  it("validates the payload", async () => {
    const a = app(store);
    expect((await a.request(`${ORIGIN}/auth/signup`, json({ email: "not-an-email", password: "demo1234" }))).status).toBe(400);
    expect((await a.request(`${ORIGIN}/auth/signup`, json({ email: "a@example.com", password: "short" }))).status).toBe(400);
    expect((await a.request(`${ORIGIN}/auth/signup`, json({}))).status).toBe(400);
  });

  it("rejects a duplicate email with 409 regardless of case", async () => {
    const a = app(store);
    await a.request(`${ORIGIN}/auth/signup`, json({ email: "dup@example.com", password: "demo1234" }));
    const again = await a.request(`${ORIGIN}/auth/signup`, json({ email: "DUP@example.com", password: "demo1234" }));
    expect(again.status).toBe(409);
  });

  it("logs in with the right password and rejects the wrong one with the same message", async () => {
    const a = app(store);
    await a.request(`${ORIGIN}/auth/signup`, json({ email: "a@example.com", password: "demo1234" }));

    const good = await a.request(`${ORIGIN}/auth/login`, json({ email: "a@example.com", password: "demo1234" }));
    expect(good.status).toBe(200);
    expect(cookieFrom(good)).not.toBe(`${SESSION_COOKIE}=`);

    const badPassword = await a.request(`${ORIGIN}/auth/login`, json({ email: "a@example.com", password: "wrong-one" }));
    const noSuchUser = await a.request(`${ORIGIN}/auth/login`, json({ email: "ghost@example.com", password: "demo1234" }));
    expect(badPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical body, so the endpoint does not disclose which addresses are registered.
    expect(await badPassword.json()).toEqual(await noSuchUser.json());
  });

  it("logs out, deletes the session, and stops answering /auth/me", async () => {
    const a = app(store);
    const signup = await a.request(`${ORIGIN}/auth/signup`, json({ email: "a@example.com", password: "demo1234" }));
    const cookie = cookieFrom(signup);

    const out = await a.request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    const meAfterLogout = await a.request(`${ORIGIN}/auth/me`, { headers: { cookie } });
    expect(meAfterLogout.status).toBe(401);
  });

  it("401s /auth/me with no cookie", async () => {
    expect((await app(store).request(`${ORIGIN}/auth/me`)).status).toBe(401);
  });

  it("throttles the eleventh failed login and clears the counter on success", async () => {
    const a = app(store);
    await a.request(`${ORIGIN}/auth/signup`, json({ email: "a@example.com", password: "demo1234" }));
    for (let i = 0; i < 10; i++) {
      const res = await a.request(`${ORIGIN}/auth/login`, json({ email: "a@example.com", password: "wrong-one" }));
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const throttled = await a.request(`${ORIGIN}/auth/login`, json({ email: "a@example.com", password: "demo1234" }));
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);

    resetThrottleForTests();
    expect((await a.request(`${ORIGIN}/auth/login`, json({ email: "a@example.com", password: "demo1234" }))).status).toBe(200);
  });
});
