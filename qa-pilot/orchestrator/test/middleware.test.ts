import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { requireUser, evictSession, clearSessionCache, type AuthEnv } from "../src/auth/middleware.js";
import { SESSION_COOKIE, hashToken, mintToken, SESSION_TTL_MS } from "../src/auth/session.js";

function appWith(store: Store) {
  const app = new Hono<AuthEnv>();
  app.use("*", requireUser(store));
  app.get("/who", (c) => c.json({ email: c.get("user").email }));
  return app;
}

describe("requireUser", () => {
  let store: Store;
  let token: string;

  beforeEach(async () => {
    clearSessionCache();
    store = memoryStore();
    const user = await store.createUser("a@example.com", "h");
    token = mintToken();
    await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  });

  it("401s with no cookie", async () => {
    const res = await appWith(store).request("http://localhost:4000/who");
    expect(res.status).toBe(401);
  });

  it("401s for an unknown token", async () => {
    const res = await appWith(store).request("http://localhost:4000/who", { headers: { cookie: `${SESSION_COOKIE}=bogus` } });
    expect(res.status).toBe(401);
  });

  it("resolves the user for a valid session", async () => {
    const res = await appWith(store).request("http://localhost:4000/who", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@example.com" });
  });

  it("serves a repeat request from cache without touching the store", async () => {
    let lookups = 0;
    const counting: Store = { ...store, async findSession(h) { lookups++; return store.findSession(h); } };
    const app = appWith(counting);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    await app.request("http://localhost:4000/who", { headers });
    await app.request("http://localhost:4000/who", { headers });
    await app.request("http://localhost:4000/who", { headers });
    expect(lookups).toBe(1);
  });

  it("stops serving a session from cache once it is evicted", async () => {
    const app = appWith(store);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    expect((await app.request("http://localhost:4000/who", { headers })).status).toBe(200);
    await store.deleteSession(hashToken(token));
    evictSession(hashToken(token));
    expect((await app.request("http://localhost:4000/who", { headers })).status).toBe(401);
  });
});
