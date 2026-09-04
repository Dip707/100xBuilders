import { Hono } from "hono";
import { z } from "zod";
import { EmailTakenError, normaliseEmail, type Store, type User } from "../store/types.js";
import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_TTL_MS, clearSessionCookie, hashToken, mintToken, readSessionCookie, setSessionCookie } from "./session.js";
import { evictSession, requireUser, type AuthEnv } from "./middleware.js";
import { checkThrottle, clearThrottle } from "./throttle.js";

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
});

/** The shape sent to the browser. Never includes passwordHash. */
function publicUser(user: User): { id: string; email: string; createdAt: string } {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

async function issueSession(store: Store, userId: string): Promise<string> {
  const token = mintToken();
  await store.createSession(hashToken(token), userId, new Date(Date.now() + SESSION_TTL_MS));
  return token;
}

export function authRoutes(store: Store): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/signup", async (c) => {
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      const user = await store.createUser(parsed.data.email, await hashPassword(parsed.data.password));
      setSessionCookie(c, await issueSession(store, user.id));
      return c.json({ user: publicUser(user) }, 201);
    } catch (err) {
      if (err instanceof EmailTakenError) return c.json({ error: "that email is already registered" }, 409);
      throw err;
    }
  });

  app.post("/login", async (c) => {
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const key = normaliseEmail(parsed.data.email);

    const allowed = checkThrottle(key);
    if (!allowed.ok) {
      return c.json({ error: "too many attempts, try again shortly" }, 429, { "retry-after": String(allowed.retryAfterSeconds) });
    }

    const found = await store.findUserByEmail(parsed.data.email);
    const ok = found ? await verifyPassword(parsed.data.password, found.passwordHash) : false;
    // One message and one status for both "no such account" and "wrong password", so the
    // endpoint does not disclose which addresses are registered.
    if (!found || !ok) return c.json({ error: "invalid email or password" }, 401);

    clearThrottle(key);
    setSessionCookie(c, await issueSession(store, found.id));
    return c.json({ user: publicUser(found) });
  });

  app.post("/logout", async (c) => {
    const token = readSessionCookie(c);
    if (token) {
      const tokenHash = hashToken(token);
      await store.deleteSession(tokenHash);
      evictSession(tokenHash);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/me", requireUser(store), (c) => c.json({ user: publicUser(c.get("user")) }));

  return app;
}
