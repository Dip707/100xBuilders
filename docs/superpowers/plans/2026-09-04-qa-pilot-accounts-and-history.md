# qa-pilot Accounts, Run History, and UI Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give qa-pilot email and password accounts, a MongoDB Atlas run index that makes finished runs listable and reopenable, and a restructured Next.js UI built as an app shell with routes.

**Architecture:** The orchestrator API at `:4000` owns authentication and the store, because the CLI also creates runs and a single writer over one schema is only possible if the store lives in the orchestrator. The UI is a thin client that calls `:4000` with `credentials: "include"`. MongoDB holds identity and run metadata; `output/<run_id>/` keeps every artifact, so replaying a finished run reuses the event stream that already exists rather than a second read path.

**Tech Stack:** TypeScript, Hono, MongoDB Atlas via the official `mongodb` driver, `node:crypto` scrypt, LangGraph.js (untouched), Next.js 16 App Router, Tailwind 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-qa-pilot-accounts-and-history-design.md`

## Global Constraints

- Node >= 22. The repo is npm workspaces: `orchestrator`, `runner`, `targets/mini-shop`, `ui`.
- Never use the em dash character. Use a plain hyphen.
- Do not add a co-author trailer to commit messages.
- All orchestrator source is ESM with `NodeNext` resolution: **every relative import must carry a `.js` extension**, even from a `.ts` file. `import { getBus } from "./events.js"`.
- `strict: true` everywhere. No `any` without a written reason in a comment.
- Only one new runtime dependency is authorised: `mongodb`. Passwords use `node:crypto` scrypt. No shadcn, no Radix, no bcrypt, no argon2, no auth framework.
- Env vars, exact names: `QA_PILOT_MONGO_URL` (required, no default), `QA_PILOT_MONGO_DB` (default `qa_pilot`), `QA_PILOT_UI_ORIGIN` (default `http://localhost:3000`).
- **Ruling 4:** `QA_PILOT_MONGO_URL` is canonical, but the store falls back to `MONGO_URI` because the operator's existing `qa-pilot/.env` holds the real Atlas string under that name. Resolution order: `QA_PILOT_MONGO_URL ?? MONGO_URI`.
- Cookie name, exact: `qa_pilot_session`. Attributes `httpOnly`, `sameSite=Lax`, `path=/`, `maxAge` 30 days, `secure` unless the request host is localhost.
- Session expiry: 30 days. Session cache TTL: 30 seconds. Login throttle: 10 attempts per 5 minutes per lowercased email. Stale-heartbeat threshold: 5 minutes.
- scrypt parameters, exact: `N=16384, r=8, p=1`, 16-byte salt, 64-byte derived key.
- An ownership failure returns **404, never 403**.
- A run's `status` is one of `running`, `done`, `partial`, `failed`, `interrupted`.
- The store never persists the credentials for the application under test. Only `url`, `intent`, and a `hasPrd` boolean.
- Status colour never carries meaning alone in the UI. Every status renders an icon and a word.
- `npm test` must pass with no database reachable.

---

## File Structure

### Created

| File | Responsibility |
| --- | --- |
| `orchestrator/src/store/types.ts` | `Store` interface, `User`, `RunRecord`, `RunStatus`, `EmailTakenError`, `withDerivedStatus` |
| `orchestrator/src/store/memory.ts` | `memoryStore()`, the `Store` over plain Maps, for tests |
| `orchestrator/src/store/mongo.ts` | `mongoStore()`, memoised `MongoClient`, index creation |
| `orchestrator/src/store/index.ts` | `defaultStore()` reading the environment |
| `orchestrator/src/auth/password.ts` | `hashPassword`, `verifyPassword` over scrypt |
| `orchestrator/src/auth/session.ts` | Token mint and hash, cookie read and write helpers, `SESSION_COOKIE` |
| `orchestrator/src/auth/middleware.ts` | `requireUser` Hono middleware, the session cache, `evictSession` |
| `orchestrator/src/auth/throttle.ts` | `checkThrottle`, `clearThrottle` |
| `orchestrator/src/auth/routes.ts` | The `/auth/*` route group |
| `orchestrator/src/runs/manifest.ts` | `artifactManifest(runId)` reading the run directory |
| `orchestrator/test/store.test.ts` | Contract suite parametrised over both store implementations |
| `orchestrator/test/password.test.ts` | scrypt round trip and rejection cases |
| `orchestrator/test/auth.test.ts` | Signup, login, logout, me, throttle, cookie flags |
| `orchestrator/test/ownership.test.ts` | Account B gets 404 on account A's run, on all four run-scoped routes |
| `orchestrator/test/recording.test.ts` | Insert before resolve, summary on success, failed on throw, heartbeat |
| `ui/lib/derive.ts` | Pure event-to-view-model functions |
| `ui/lib/api.ts` | Typed fetch wrapper, `credentials: "include"`, 401 handling |
| `ui/lib/auth.tsx` | `AuthProvider`, `useUser` |
| `ui/middleware.ts` | Cookie presence check and redirect |
| `ui/vitest.config.ts` | Vitest for the `lib/derive.ts` tests |
| `ui/test/derive.test.ts` | Unit tests for the derive functions |
| `ui/components/ui/*` | Button Input Textarea Checkbox Segmented Field Card StatusPill Table Tabs Meter Breadcrumb EmptyState Spinner |
| `ui/components/shell/*` | Sidebar, UserMenu, BudgetCard, PageHeader |
| `ui/components/auth/AuthForm.tsx` | The shared login and signup form |
| `ui/lib/format.ts` | `relativeTime`, `formatDuration`, `hostOf` |
| `ui/components/run/*` | RunHeader Pipeline Feed Decisions Results PlanPanel BrowserCard SummaryCard ReportFrame |
| `ui/components/runs/*` | RunTable, StatCard |
| `ui/app/login/page.tsx`, `ui/app/signup/page.tsx` | Auth screens |
| `ui/app/(app)/layout.tsx` | The shell and the client-side auth gate |
| `ui/app/(app)/page.tsx` | Overview |
| `ui/app/(app)/runs/new/page.tsx` | Start a run |
| `ui/app/(app)/runs/[id]/page.tsx` | Run detail |

### Modified

| File | Change |
| --- | --- |
| `orchestrator/package.json` | Add the `mongodb` dependency |
| `orchestrator/src/state.ts` | `RunInputSchema` gains `userId` |
| `orchestrator/src/run.ts` | `startRun` becomes async, records the run, heartbeats |
| `orchestrator/src/api.ts` | Store injection, auth mount, guards on every run-scoped route, `/runs`, `/runs/:id`, `/health` |
| `orchestrator/src/cli.ts` | Resolve the reserved local account, await `startRun` |
| `orchestrator/test/api.test.ts` | Inject `memoryStore`, add an authenticated-request helper, keep every traversal assertion verbatim |
| `orchestrator/test/graph.test.ts` | `await startRun(...)` at line 42, pass a `userId` |
| `ui/app/globals.css` | Replace ad-hoc literals with tokens, delete the Arial override |
| `ui/app/layout.tsx` | Keep fonts only; the shell moves to the route group |
| `ui/app/page.tsx` | Deleted; replaced by the route group |
| `ui/app/components/*` | Deleted; replaced by `ui/components/**` |
| `ui/lib/events.ts` | `EventSource` gains `withCredentials`, `startRun` moves to `lib/api.ts` |
| `ui/package.json` | Add vitest and a `test` script |
| `package.json` (root) | Root `test` script includes the `ui` workspace |
| `.env.example`, `README.md`, `ARCHITECTURE.md` | The three new env vars, the auth and history sections |

---

## Task 1: Store types and the in-memory implementation

**Files:**
- Create: `orchestrator/src/store/types.ts`
- Create: `orchestrator/src/store/memory.ts`
- Test: `orchestrator/test/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Store`, `User`, `RunRecord`, `RunStatus`, `EmailTakenError`, `withDerivedStatus(rec: RunRecord): RunRecord`, `STALE_HEARTBEAT_MS`, `memoryStore(): Store`.

- [ ] **Step 1: Write the failing contract test**

Create `orchestrator/test/store.test.ts`. This file is written once and grows a second implementation in Task 2, so it takes the store as a factory from the start.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { withDerivedStatus, STALE_HEARTBEAT_MS, EmailTakenError, type Store, type RunRecord } from "../src/store/types.js";

function runRec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1", userId: "u1", url: "http://localhost:3005",
    hasPrd: false, status: "running", startedAt: new Date().toISOString(), ...over,
  };
}

const factories: Array<[string, () => Promise<Store>]> = [["memory", async () => memoryStore()]];

describe.each(factories)("store contract (%s)", (_name, make) => {
  let store: Store;
  beforeEach(async () => { store = await make(); });

  it("creates a user and finds it by email, case-insensitively", async () => {
    const u = await store.createUser("Foo@Example.com", "hash1");
    expect(u.id).toMatch(/./);
    expect(u.email).toBe("foo@example.com");
    const found = await store.findUserByEmail("foo@EXAMPLE.com");
    expect(found?.passwordHash).toBe("hash1");
    expect(await store.findUserById(u.id)).toMatchObject({ email: "foo@example.com" });
  });

  it("rejects a duplicate email with EmailTakenError regardless of case", async () => {
    await store.createUser("dup@example.com", "h");
    await expect(store.createUser("DUP@example.com", "h2")).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("returns null for an unknown user", async () => {
    expect(await store.findUserByEmail("nobody@example.com")).toBeNull();
    expect(await store.findUserById("nope")).toBeNull();
  });

  it("stores and deletes a session and honours expiry", async () => {
    const future = new Date(Date.now() + 60_000);
    await store.createSession("hash-a", "u1", future);
    expect(await store.findSession("hash-a")).toMatchObject({ userId: "u1" });
    await store.deleteSession("hash-a");
    expect(await store.findSession("hash-a")).toBeNull();

    await store.createSession("hash-b", "u1", new Date(Date.now() - 1000));
    expect(await store.findSession("hash-b")).toBeNull();
  });

  it("inserts, patches, and reads a run", async () => {
    await store.insertRun(runRec());
    await store.updateRun("run-1", { status: "done", testsPassed: 3, testsFailed: 1 });
    const got = await store.getRun("run-1");
    expect(got).toMatchObject({ status: "done", testsPassed: 3, testsFailed: 1 });
    expect(await store.getRun("missing")).toBeNull();
  });

  it("lists a user's runs newest first and never another user's", async () => {
    await store.insertRun(runRec({ id: "run-old", startedAt: "2026-01-01T00:00:00.000Z" }));
    await store.insertRun(runRec({ id: "run-new", startedAt: "2026-02-01T00:00:00.000Z" }));
    await store.insertRun(runRec({ id: "run-other", userId: "u2" }));
    const mine = await store.listRuns("u1");
    expect(mine.map((r) => r.id)).toEqual(["run-new", "run-old"]);
  });

  it("touchRun advances the heartbeat", async () => {
    await store.insertRun(runRec({ heartbeatAt: "2026-01-01T00:00:00.000Z" }));
    await store.touchRun("run-1");
    const got = await store.getRun("run-1");
    expect(new Date(got!.heartbeatAt!).getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("reads a running run with a stale heartbeat as interrupted", async () => {
    const stale = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
    await store.insertRun(runRec({ id: "run-stale", heartbeatAt: stale }));
    expect((await store.getRun("run-stale"))!.status).toBe("interrupted");
    const listed = await store.listRuns("u1");
    expect(listed.find((r) => r.id === "run-stale")!.status).toBe("interrupted");
  });
});

describe("withDerivedStatus", () => {
  it("leaves a fresh running run alone", () => {
    const rec = runRec({ heartbeatAt: new Date().toISOString() });
    expect(withDerivedStatus(rec).status).toBe("running");
  });
  it("leaves a running run with no heartbeat alone, since it may have just started", () => {
    expect(withDerivedStatus(runRec()).status).toBe("running");
  });
  it("does not touch a terminal status even with an ancient heartbeat", () => {
    const rec = runRec({ status: "done", heartbeatAt: "2020-01-01T00:00:00.000Z" });
    expect(withDerivedStatus(rec).status).toBe("done");
  });
});
```

Note the third `withDerivedStatus` case: a `running` record with **no** heartbeat at all is left as `running`, because a run that has just been inserted has not finished its first node yet and must not immediately read as interrupted.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- store`
Expected: FAIL, cannot resolve `../src/store/memory.js`.

- [ ] **Step 3: Write `orchestrator/src/store/types.ts`**

```ts
/** How long a `running` run may go without a heartbeat before it reads as interrupted. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;

export type RunStatus = "running" | "done" | "partial" | "failed" | "interrupted";

export type User = { id: string; email: string; createdAt: string };

export type RunRecord = {
  id: string;
  userId: string;
  url: string;
  intent?: string;
  hasPrd: boolean;
  status: RunStatus;
  startedAt: string;
  heartbeatAt?: string;
  finishedAt?: string;
  durationMs?: number;
  coverageScore?: number;
  planIterations?: number;
  flowsTotal?: number;
  testsPassed?: number;
  testsFailed?: number;
  healsAccepted?: number;
  defectsCount?: number;
  llmCalls?: number;
  partialReason?: string;
};

/** Thrown by `createUser` so the route layer never sees a driver-specific duplicate-key error. */
export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`email already registered: ${email}`);
    this.name = "EmailTakenError";
  }
}

/**
 * A run whose process died leaves its document saying `running` forever. Rather than
 * rewriting rows at boot - which on a shared Atlas cluster would clobber a teammate's
 * in-flight runs - the status is corrected on read. A `running` record with no heartbeat
 * at all is left alone: it was inserted moments ago and has not finished a node yet.
 */
export function withDerivedStatus(rec: RunRecord): RunRecord {
  if (rec.status !== "running" || !rec.heartbeatAt) return rec;
  const age = Date.now() - Date.parse(rec.heartbeatAt);
  return age > STALE_HEARTBEAT_MS ? { ...rec, status: "interrupted" } : rec;
}

/** Normalised form used for both storage and lookup, so case never creates two accounts. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Store {
  createUser(email: string, passwordHash: string): Promise<User>;
  findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  findUserById(id: string): Promise<User | null>;

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(tokenHash: string): Promise<void>;

  insertRun(rec: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  touchRun(id: string): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(userId: string, limit?: number): Promise<RunRecord[]>;

  close(): Promise<void>;
}
```

- [ ] **Step 4: Write `orchestrator/src/store/memory.ts`**

```ts
import { randomUUID } from "node:crypto";
import { EmailTakenError, normaliseEmail, withDerivedStatus, type RunRecord, type Store, type User } from "./types.js";

/**
 * The `Store` over plain Maps. Used by every test that is not specifically testing Mongo,
 * mirroring how the LLM client is already faked in this codebase, so `npm test` needs no
 * database. Expiry and derived status are implemented here exactly as Mongo implements
 * them, and `test/store.test.ts` runs the same contract against both.
 */
export function memoryStore(): Store {
  const users = new Map<string, User & { passwordHash: string }>();
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const runs = new Map<string, RunRecord>();

  return {
    async createUser(email, passwordHash) {
      const normalised = normaliseEmail(email);
      for (const u of users.values()) if (u.email === normalised) throw new EmailTakenError(normalised);
      const user = { id: randomUUID(), email: normalised, createdAt: new Date().toISOString(), passwordHash };
      users.set(user.id, user);
      return { id: user.id, email: user.email, createdAt: user.createdAt };
    },
    async findUserByEmail(email) {
      const normalised = normaliseEmail(email);
      for (const u of users.values()) if (u.email === normalised) return { ...u };
      return null;
    },
    async findUserById(id) {
      const u = users.get(id);
      return u ? { id: u.id, email: u.email, createdAt: u.createdAt } : null;
    },

    async createSession(tokenHash, userId, expiresAt) {
      sessions.set(tokenHash, { userId, expiresAt });
    },
    async findSession(tokenHash) {
      const s = sessions.get(tokenHash);
      if (!s) return null;
      // Mongo's TTL index reaps lazily, so a just-expired document can still be read there;
      // both implementations therefore check expiry explicitly rather than trusting the index.
      if (s.expiresAt.getTime() <= Date.now()) { sessions.delete(tokenHash); return null; }
      return { ...s };
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },

    async insertRun(rec) {
      runs.set(rec.id, { ...rec });
    },
    async updateRun(id, patch) {
      const cur = runs.get(id);
      if (cur) runs.set(id, { ...cur, ...patch });
    },
    async touchRun(id) {
      const cur = runs.get(id);
      if (cur) runs.set(id, { ...cur, heartbeatAt: new Date().toISOString() });
    },
    async getRun(id) {
      const rec = runs.get(id);
      return rec ? withDerivedStatus({ ...rec }) : null;
    },
    async listRuns(userId, limit = 100) {
      return [...runs.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((r) => withDerivedStatus({ ...r }));
    },

    async close() { /* nothing to release */ },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w orchestrator -- store`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w orchestrator`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/store orchestrator/test/store.test.ts
git commit -m "qa-pilot: store interface and in-memory implementation"
```

---

## Task 2: The MongoDB implementation

**Files:**
- Create: `orchestrator/src/store/mongo.ts`
- Create: `orchestrator/src/store/index.ts`
- Modify: `orchestrator/package.json`
- Modify: `orchestrator/test/store.test.ts` (register the second factory)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `mongoStore(opts?: { url?: string; db?: string }): Promise<Store>`, `defaultStore(): Promise<Store>`.

- [ ] **Step 1: Install the driver**

```bash
npm install mongodb -w orchestrator
```

- [ ] **Step 2: Extend the contract test with the Mongo factory**

Replace the `factories` line in `orchestrator/test/store.test.ts` with this block, and leave every `it` body untouched:

```ts
// The Mongo pass runs only when a URL is configured. It forces a database name ending in
// "_test" and refuses to drop anything else, so a stray run can never wipe the real
// qa_pilot database on a shared Atlas cluster.
// Deliberately reads the environment WITHOUT loading .env, so the default `npm test`
// stays hermetic and offline. MONGO_URI is accepted alongside the canonical name because
// that is what the operator's .env already uses (Rulings 4 and 5).
const mongoUrl = process.env.QA_PILOT_MONGO_URL ?? process.env.MONGO_URI;
const mongoDb = `qa_pilot_contract_${process.pid}_test`;

const factories: Array<[string, () => Promise<Store>]> = [["memory", async () => memoryStore()]];
if (mongoUrl) factories.push(["mongo", async () => {
  const { mongoStore, dropDatabaseForTests } = await import("../src/store/mongo.js");
  await dropDatabaseForTests(mongoUrl, mongoDb);
  return mongoStore({ url: mongoUrl, db: mongoDb });
}]);
```

And add this after the `describe.each` block so the contract database is cleaned up:

```ts
afterAll(async () => {
  if (!mongoUrl) return;
  const { dropDatabaseForTests } = await import("../src/store/mongo.js");
  await dropDatabaseForTests(mongoUrl, mongoDb);
});
```

Add `afterAll` to the existing vitest import at the top of the file.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w orchestrator -- store`
Expected: PASS for the memory pass (Mongo is skipped with no URL). Then, with a URL exported, FAIL: cannot resolve `../src/store/mongo.js`.

- [ ] **Step 4: Write `orchestrator/src/store/mongo.ts`**

```ts
import { MongoClient, type Collection, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { EmailTakenError, normaliseEmail, withDerivedStatus, type RunRecord, type Store, type User } from "./types.js";

type UserDoc = { _id: string; email: string; passwordHash: string; createdAt: string };
type SessionDoc = { _id: string; userId: string; createdAt: string; expiresAt: Date };
type RunDoc = Omit<RunRecord, "id"> & { _id: string };

const DUPLICATE_KEY = 11000;
/** Case-insensitive comparison for the unique email index and for lookups. */
const CI = { locale: "en", strength: 2 } as const;

/**
 * One client per url+db, memoised so the driver's connection pool is reused across
 * requests instead of being rebuilt per call. serverSelectionTimeoutMS is set low enough
 * that a wrong URL or an Atlas IP allowlist that has not been updated fails at boot with
 * a readable error rather than hanging the API for the driver's 30s default.
 */
const clients = new Map<string, Promise<MongoClient>>();

function client(url: string): Promise<MongoClient> {
  let existing = clients.get(url);
  if (!existing) {
    existing = new MongoClient(url, { serverSelectionTimeoutMS: 8000 }).connect();
    clients.set(url, existing);
    existing.catch(() => clients.delete(url));
  }
  return existing;
}

async function ensureIndexes(db: Db): Promise<void> {
  await db.collection<UserDoc>("users").createIndex({ email: 1 }, { unique: true, collation: CI, name: "email_unique_ci" });
  // expireAfterSeconds: 0 means "expire at the time in this field", so Mongo reaps
  // expired sessions instead of application code.
  await db.collection<SessionDoc>("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "session_ttl" });
  await db.collection<RunDoc>("runs").createIndex({ userId: 1, startedAt: -1 }, { name: "runs_by_user_recent" });
}

function toRecord(doc: RunDoc): RunRecord {
  const { _id, ...rest } = doc;
  return withDerivedStatus({ id: _id, ...rest });
}

export async function mongoStore(opts: { url?: string; db?: string } = {}): Promise<Store> {
  // QA_PILOT_MONGO_URL is canonical; MONGO_URI is accepted because that is the name the
  // operator's existing qa-pilot/.env already uses for the Atlas string (Ruling 4).
  const url = opts.url ?? process.env.QA_PILOT_MONGO_URL ?? process.env.MONGO_URI;
  if (!url) throw new Error("QA_PILOT_MONGO_URL is not set. Put the Atlas connection string in qa-pilot/.env");
  const dbName = opts.db ?? process.env.QA_PILOT_MONGO_DB ?? "qa_pilot";
  const db = (await client(url)).db(dbName);
  await ensureIndexes(db);

  const users: Collection<UserDoc> = db.collection("users");
  const sessions: Collection<SessionDoc> = db.collection("sessions");
  const runs: Collection<RunDoc> = db.collection("runs");

  return {
    async createUser(email, passwordHash) {
      const doc: UserDoc = { _id: randomUUID(), email: normaliseEmail(email), passwordHash, createdAt: new Date().toISOString() };
      try {
        await users.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === DUPLICATE_KEY) throw new EmailTakenError(doc.email);
        throw err;
      }
      return { id: doc._id, email: doc.email, createdAt: doc.createdAt };
    },
    async findUserByEmail(email) {
      const doc = await users.findOne({ email: normaliseEmail(email) }, { collation: CI });
      return doc ? { id: doc._id, email: doc.email, createdAt: doc.createdAt, passwordHash: doc.passwordHash } : null;
    },
    async findUserById(id) {
      const doc = await users.findOne({ _id: id });
      return doc ? { id: doc._id, email: doc.email, createdAt: doc.createdAt } : null;
    },

    async createSession(tokenHash, userId, expiresAt) {
      await sessions.insertOne({ _id: tokenHash, userId, createdAt: new Date().toISOString(), expiresAt });
    },
    async findSession(tokenHash) {
      const doc = await sessions.findOne({ _id: tokenHash });
      if (!doc) return null;
      // The TTL monitor runs about once a minute, so an expired document can still be
      // readable. Check explicitly rather than trusting the index for correctness.
      if (doc.expiresAt.getTime() <= Date.now()) return null;
      return { userId: doc.userId, expiresAt: doc.expiresAt };
    },
    async deleteSession(tokenHash) {
      await sessions.deleteOne({ _id: tokenHash });
    },

    async insertRun(rec) {
      const { id, ...rest } = rec;
      await runs.insertOne({ _id: id, ...rest });
    },
    async updateRun(id, patch) {
      const { id: _ignored, ...fields } = patch as Partial<RunRecord> & { id?: string };
      if (Object.keys(fields).length === 0) return;
      await runs.updateOne({ _id: id }, { $set: fields });
    },
    async touchRun(id) {
      await runs.updateOne({ _id: id }, { $set: { heartbeatAt: new Date().toISOString() } });
    },
    async getRun(id) {
      const doc = await runs.findOne({ _id: id });
      return doc ? toRecord(doc) : null;
    },
    async listRuns(userId, limit = 100) {
      const docs = await runs.find({ userId }).sort({ startedAt: -1 }).limit(limit).toArray();
      return docs.map(toRecord);
    },

    async close() {
      const c = clients.get(url);
      if (!c) return;
      clients.delete(url);
      await (await c).close();
    },
  };
}

/**
 * Test-only teardown. Refuses any database name that does not end in "_test", so a
 * mistake in a test file cannot drop the real qa_pilot database on a shared cluster.
 */
export async function dropDatabaseForTests(url: string, dbName: string): Promise<void> {
  if (!dbName.endsWith("_test")) throw new Error(`refusing to drop "${dbName}": test databases must end in _test`);
  await (await client(url)).db(dbName).dropDatabase();
}
```

- [ ] **Step 5: Write `orchestrator/src/store/index.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests both ways**

Run: `npm test -w orchestrator -- store`
Expected: PASS, memory pass only, Mongo skipped.

Run, from the `qa-pilot/` workspace root:

```bash
QA_PILOT_MONGO_URL="$(grep -m1 '^MONGO_URI=' .env | cut -d= -f2-)" npm test -w orchestrator -- store
```

Expected: PASS, both passes, 19 tests (8 contract tests per store implementation, plus 3 withDerivedStatus tests). If this fails with a server-selection timeout, the Atlas IP allowlist is the first thing to check.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/store orchestrator/test/store.test.ts orchestrator/package.json package-lock.json
git commit -m "qa-pilot: MongoDB store implementation behind the store interface"
```

---

## Task 3: Password hashing

**Files:**
- Create: `orchestrator/src/auth/password.ts`
- Test: `orchestrator/test/password.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, stored: string): Promise<boolean>`, `UNUSABLE_PASSWORD_HASH: "-"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, UNUSABLE_PASSWORD_HASH } from "../src/auth/password.js";

describe("password", () => {
  it("round trips a correct password", async () => {
    const stored = await hashPassword("demo1234");
    expect(await verifyPassword("demo1234", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("demo1234");
    expect(await verifyPassword("demo12345", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("embeds the parameters and a unique salt, and never the plaintext", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("same-password");
  });

  it("returns false rather than throwing for an unparseable hash", async () => {
    for (const bad of [UNUSABLE_PASSWORD_HASH, "", "nonsense", "scrypt$bad$x$y", "bcrypt$1$2$3"]) {
      expect(await verifyPassword("anything", bad), bad).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- password`
Expected: FAIL, cannot resolve `../src/auth/password.js`.

- [ ] **Step 3: Write `orchestrator/src/auth/password.ts`**

```ts
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (p: string | Buffer, s: Buffer, k: number, o: { N: number; r: number; p: number }) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * A hash that can never validate. Stored on the reserved CLI account so its runs can be
 * attributed without the account being loggable-into: verifyPassword cannot parse it and
 * therefore returns false for every input.
 */
export const UNUSABLE_PASSWORD_HASH = "-";

/** `scrypt$N=16384,r=8,p=1$<salt b64>$<key b64>`. Parameters travel with the hash so the cost can be raised later without invalidating existing accounts. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES, PARAMS);
  return `scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await scryptAsync(plain, parsed.salt, parsed.key.length, parsed.params);
  // Lengths are equal by construction here, but timingSafeEqual throws on a mismatch,
  // so guard rather than let a malformed stored hash become an exception.
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

function parse(stored: string): { params: { N: number; r: number; p: number }; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;
  const matched = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!matched) return null;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const key = Buffer.from(parts[3], "base64");
    if (salt.length === 0 || key.length === 0) return null;
    return { params: { N: Number(matched[1]), r: Number(matched[2]), p: Number(matched[3]) }, salt, key };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w orchestrator -- password`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/auth/password.ts orchestrator/test/password.test.ts
git commit -m "qa-pilot: scrypt password hashing"
```

---

## Task 4: Session tokens and the cookie

**Files:**
- Create: `orchestrator/src/auth/session.ts`
- Test: extends `orchestrator/test/auth.test.ts` in Task 6; this task's own behaviour is covered by the tests written there, so it commits with a small dedicated test instead.

**Interfaces:**
- Consumes: `Store` from Task 1.
- Produces: `SESSION_COOKIE: "qa_pilot_session"`, `SESSION_TTL_MS`, `mintToken(): string`, `hashToken(token: string): string`, `setSessionCookie(c: Context, token: string): void`, `clearSessionCookie(c: Context): void`, `readSessionCookie(c: Context): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `orchestrator/test/session.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- session`
Expected: FAIL, cannot resolve `../src/auth/session.js`.

- [ ] **Step 3: Write `orchestrator/src/auth/session.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w orchestrator -- session`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/auth/session.ts orchestrator/test/session.test.ts
git commit -m "qa-pilot: session tokens and cookie handling"
```

---

## Task 5: The `requireUser` middleware and its session cache

**Files:**
- Create: `orchestrator/src/auth/middleware.ts`
- Test: covered by `orchestrator/test/auth.test.ts` in Task 6, plus the cache test written here in `orchestrator/test/middleware.test.ts`.

**Interfaces:**
- Consumes: `Store`, `readSessionCookie`, `hashToken`.
- Produces: `type AuthEnv = { Variables: { user: User } }`, `requireUser(store: Store): MiddlewareHandler<AuthEnv>`, `evictSession(tokenHash: string): void`, `clearSessionCache(): void`.

- [ ] **Step 1: Write the failing test**

Create `orchestrator/test/middleware.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- middleware`
Expected: FAIL, cannot resolve `../src/auth/middleware.js`.

- [ ] **Step 3: Write `orchestrator/src/auth/middleware.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w orchestrator -- middleware`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/auth/middleware.ts orchestrator/test/middleware.test.ts
git commit -m "qa-pilot: requireUser middleware with a short-lived session cache"
```

---

## Task 6: The auth routes and the login throttle

**Files:**
- Create: `orchestrator/src/auth/throttle.ts`
- Create: `orchestrator/src/auth/routes.ts`
- Test: `orchestrator/test/auth.test.ts`

**Interfaces:**
- Consumes: `Store`, `hashPassword`, `verifyPassword`, session helpers, `requireUser`, `evictSession`.
- Produces: `authRoutes(store: Store): Hono<AuthEnv>` mounted by the API at `/auth`; `checkThrottle(key: string): { ok: true } | { ok: false; retryAfterSeconds: number }`, `clearThrottle(key: string): void`, `resetThrottleForTests(): void`.

- [ ] **Step 1: Write the failing test**

Create `orchestrator/test/auth.test.ts`:

```ts
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
    expect(await a.request(`${ORIGIN}/auth/me`, { headers: { cookie } }).then((r) => r.status)).toBe(401);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- auth`
Expected: FAIL, cannot resolve `../src/auth/routes.js`.

- [ ] **Step 3: Write `orchestrator/src/auth/throttle.ts`**

```ts
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
```

- [ ] **Step 4: Write `orchestrator/src/auth/routes.ts`**

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w orchestrator -- auth`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/auth orchestrator/test/auth.test.ts
git commit -m "qa-pilot: signup, login, logout, and me routes with a login throttle"
```

---

## Task 7: Recording every run

**Files:**
- Modify: `orchestrator/src/state.ts` (`RunInputSchema`)
- Modify: `orchestrator/src/run.ts` (whole `startRun`, plus a new exported `summarise`)
- Modify: `orchestrator/test/graph.test.ts:42`
- Test: `orchestrator/test/recording.test.ts`

**Interfaces:**
- Consumes: `Store`, `RunRecord` from Task 1.
- Produces: `StartRunInputSchema` and `type StartRunInput = RunInput & { userId: string }` from state.ts; `startRun(input: StartRunInput, opts?: { headless?: boolean; llm?: LlmClient; store?: Store }): Promise<{ runId: string; done: Promise<RunState> }>`; `summarise(state: RunState, startedAt: string, finishedAt?: string): Partial<RunRecord>`.

**Ruling 1 (binding — overrides the spec on this point).** Do NOT add `userId` to `RunInputSchema`. `initialState` calls `RunInputSchema.parse`, and 25 existing `initialState(...)` call sites across 13 test files pass no `userId`; making it required there breaks all of them. Add a sibling schema instead. `initialState` and its 25 call sites stay untouched.

- [ ] **Step 1: Write the failing test**

Create `orchestrator/test/recording.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { summarise } from "../src/run.js";
import { initialState, type RunState } from "../src/state.js";

function state(over: Partial<RunState> = {}): RunState {
  return { ...initialState({ runId: "r", url: "http://localhost:3005", userId: "u1" }), ...over };
}

describe("summarise", () => {
  it("maps a completed run onto the record fields", () => {
    const s = state({
      partial: false,
      coverage: { score: 0.82, gaps: [], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} },
      planIterations: 2,
      plan: [{ id: "a" }, { id: "b" }, { id: "c" }] as RunState["plan"],
      results: { at: "now", tests: [
        { status: "passed" }, { status: "passed" }, { status: "failed" }, { status: "timedOut" },
      ] as RunState["results"]["tests"] },
      healLog: [{ accepted: true }, { accepted: false }, { accepted: true }] as RunState["healLog"],
      defects: [{ id: "d1" }] as RunState["defects"],
      llmCalls: 17,
    });
    const out = summarise(s, "2026-09-04T10:00:00.000Z", "2026-09-04T10:05:00.000Z");
    expect(out).toMatchObject({
      status: "done", coverageScore: 0.82, planIterations: 2, flowsTotal: 3,
      testsPassed: 2, testsFailed: 2, healsAccepted: 2, defectsCount: 1,
      llmCalls: 17, durationMs: 300_000, finishedAt: "2026-09-04T10:05:00.000Z",
    });
  });

  it("reports a budget-stopped run as partial and keeps the reason", () => {
    const out = summarise(state({ partial: true, partialReason: "llm budget exceeded" }), new Date().toISOString());
    expect(out.status).toBe("partial");
    expect(out.partialReason).toBe("llm budget exceeded");
  });

  it("counts anything that is not passed as a failure, and copes with no results at all", () => {
    expect(summarise(state(), new Date().toISOString())).toMatchObject({ testsPassed: 0, testsFailed: 0, flowsTotal: 0 });
  });
});

describe("startRun recording", () => {
  // The real FakeLlmClient from src/llm/client.ts, with no canned answers: exploration of
  // mini-shop succeeds, then the plan node throws "no canned answer for prompt plan" and
  // the graph rejects. That is deterministic, unlike relying on a refused TCP port, where
  // whether the graph rejects depends on how the explore node handles a connection error.
  let shop: Awaited<ReturnType<typeof startShop>>;
  let store: Store;

  beforeAll(async () => { shop = await startShop(); });
  afterAll(async () => { await shop.stop(); });
  beforeEach(() => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-rec-")) + "/";
    store = memoryStore();
  });

  it("inserts the run as running before it resolves, and never stores target credentials", async () => {
    const { runId, done } = await startRun(
      { runId: "rec-1", url: shop.base + "/", userId: "u1", intent: "focus on auth",
        credentials: { username: "demo@shop.test", password: "demo1234" },
        prdText: "the app must let a user log in", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    // The document exists the moment startRun resolves, before the graph has finished.
    const rec = await store.getRun(runId);
    expect(rec).toMatchObject({ id: "rec-1", userId: "u1", status: "running", intent: "focus on auth", hasPrd: true });
    expect(rec!.url).toBe(shop.base);                        // trailing slash normalised away
    expect(JSON.stringify(rec)).not.toContain("demo1234");    // credentials are never persisted
    expect(JSON.stringify(rec)).not.toContain("must let a user log in");

    await done.catch(() => {});
  });

  it("marks the run failed with the error message when the graph throws", async () => {
    const { done } = await startRun(
      { runId: "rec-2", url: shop.base, userId: "u1", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    await expect(done).rejects.toThrow();
    const rec = await store.getRun("rec-2");
    expect(rec!.status).toBe("failed");
    expect(rec!.partialReason).toContain("canned answer");
    expect(rec!.finishedAt).toBeTruthy();
  });

  it("advances the heartbeat as nodes finish", async () => {
    const { done } = await startRun(
      { runId: "rec-3", url: shop.base, userId: "u1", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    await done.catch(() => {});
    // explore emits node_end before plan throws, so a heartbeat must have been stamped.
    expect((await store.getRun("rec-3"))!.heartbeatAt).toBeTruthy();
  });
});
```

The imports this file needs at the top:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { startRun, summarise } from "../src/run.js";
import { initialState, type RunState } from "../src/state.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- recording`
Expected: FAIL, `summarise` is not exported from `run.js`.

- [ ] **Step 3: Add a `StartRunInputSchema` beside `RunInputSchema`**

In `orchestrator/src/state.ts`, leave `RunInputSchema` and `initialState` **exactly as they are** and append:

```ts
/**
 * What `startRun` accepts: a run input plus the account that owns the run.
 *
 * Deliberately a sibling of RunInputSchema rather than a field on it. `initialState`
 * parses RunInputSchema and is called from a couple of dozen node-level tests that have
 * no account and no need for one, so requiring userId there would be pure churn. It is
 * equally deliberately absent from RunStateAnnotation: the graph has no interest in who
 * owns a run, and putting it in graph state would widen the checkpointed payload for
 * nothing.
 */
export const StartRunInputSchema = RunInputSchema.extend({ userId: z.string().min(1) });
export type StartRunInput = z.infer<typeof StartRunInputSchema>;
```

- [ ] **Step 4: Rewrite `orchestrator/src/run.ts`**

```ts
import "./env.js";
import { getBus, type EventBus } from "./events.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { buildGraph } from "./graph.js";
import { initialState, outputDir, StartRunInputSchema, type StartRunInput, type RunState } from "./state.js";
import { writeOutput } from "./output.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { mkdirSync } from "node:fs";

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Derives the stored summary from the graph's final state. Pure, so it is unit-tested directly. */
export function summarise(state: RunState, startedAt: string, finishedAt: string = new Date().toISOString()): Partial<RunRecord> {
  const tests = state.results?.tests ?? [];
  return {
    status: state.partial ? "partial" : "done",
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    coverageScore: state.coverage?.score,
    planIterations: state.planIterations,
    flowsTotal: state.plan.length,
    testsPassed: tests.filter((t) => t.status === "passed").length,
    // Anything that is not "passed" counts against the run: timedOut, interrupted and
    // skipped are all failures from the point of view of a history row.
    testsFailed: tests.filter((t) => t.status !== "passed").length,
    healsAccepted: state.healLog.filter((h) => h.accepted).length,
    defectsCount: state.defects.length,
    llmCalls: state.llmCalls,
    partialReason: state.partialReason,
  };
}

/** Recording must never take a run down with it, so every store write here is best-effort and reported. */
async function record(store: Store, bus: EventBus, runId: string, patch: Partial<RunRecord>): Promise<void> {
  try {
    await store.updateRun(runId, patch);
  } catch (err) {
    bus.log("orchestrator", `could not record run summary: ${(err as Error).message}`);
  }
}

export async function startRun(
  input: StartRunInput,
  opts: { headless?: boolean; llm?: LlmClient; store?: Store } = {},
): Promise<{ runId: string; done: Promise<RunState> }> {
  const parsed = StartRunInputSchema.parse(input);
  const store = opts.store ?? (await defaultStore());
  mkdirSync(outputDir(parsed.runId), { recursive: true });
  // heal.ts only writes heal-log.json when the heal node actually runs; many runs never hit a
  // "heal" classification (e.g. straight to rerun/escalate), so seed the file here to guarantee
  // the output contract - it's overwritten with the real log if heal does run.
  writeOutput(parsed.runId, "heal-log.json", []);

  const bus = getBus(parsed.runId);
  const llm = opts.llm ?? makeLlmClient(bus);
  const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS === "1";
  const graph = buildGraph({ bus, llm, headless }, { checkpointPath: outputDir(parsed.runId) + "checkpoint.db" });
  const state = initialState(parsed);

  // Inserted before this function resolves, so a caller that immediately navigates to
  // /runs/<id> cannot race a 404. Only url, intent and a hasPrd flag are stored: the
  // credentials for the application under test stay in memory for the run's lifetime.
  await store.insertRun({
    id: parsed.runId,
    userId: parsed.userId,
    url: state.url,
    intent: parsed.intent,
    hasPrd: Boolean(parsed.prdText),
    status: "running",
    startedAt: state.startedAt,
  });

  // A run whose process dies would say "running" forever. Each finished node stamps a
  // heartbeat, and the store reports a running record with a stale heartbeat as
  // interrupted. Fire and forget: a slow store must not stall the graph.
  const unsubscribe = bus.subscribe((e) => {
    if (e.type === "node_end") void store.touchRun(parsed.runId).catch(() => {});
  });

  bus.emit({ type: "agent_log", agent: "orchestrator", message: `run ${parsed.runId} started for ${parsed.url}` });

  const done = graph
    .invoke(state, { configurable: { thread_id: parsed.runId }, recursionLimit: 100 })
    .then((s) => ({ ...s, llmCalls: Math.max(s.llmCalls, llm.calls) }) as RunState)
    .then(async (s) => {
      unsubscribe();
      await record(store, bus, parsed.runId, summarise(s, state.startedAt));
      return s;
    })
    .catch(async (err: Error) => {
      unsubscribe();
      const finishedAt = new Date().toISOString();
      await record(store, bus, parsed.runId, {
        status: "failed",
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(state.startedAt),
        partialReason: err.message,
      });
      bus.emit({ type: "error", message: err.message });
      bus.emit({ type: "done", message: "failed" });
      throw err;
    });

  return { runId: parsed.runId, done };
}
```

- [ ] **Step 5: Update the integration test's call site**

Only `startRun` call sites change. Every `initialState(...)` call site in the test suite stays untouched, which is the whole point of Ruling 1 - do not add `userId` to any of them, including `graph.test.ts:67`.

In `orchestrator/test/graph.test.ts` at line 42, add `await` and a `userId`, and inject the in-memory store so the integration test needs no database:

```ts
const { runId, done } = await startRun(
  { runId: "it-1", userId: "u-test", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" }, intent: "login and checkout coupon", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
  { headless: true, llm, store: memoryStore() },
);
```

Add `import { memoryStore } from "../src/store/memory.js";` to that file's imports.

- [ ] **Step 6: Run the tests**

Run: `npm test -w orchestrator -- recording`
Expected: PASS, 6 tests.

Run: `npm run typecheck -w orchestrator`
Expected: errors only in `src/api.ts` and `src/cli.ts`, which Tasks 9 and 10 fix. Everything else clean.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/state.ts orchestrator/src/run.ts orchestrator/test/recording.test.ts orchestrator/test/graph.test.ts
git commit -m "qa-pilot: record every run in the store with a heartbeat and a summary"
```

---

## Task 8: The artifact manifest

**Files:**
- Create: `orchestrator/src/runs/manifest.ts`
- Test: `orchestrator/test/manifest.test.ts`

**Interfaces:**
- Consumes: `outputDir` from `state.ts`.
- Produces: `artifactManifest(runId: string): ArtifactManifest`, `type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactManifest } from "../src/runs/manifest.js";

describe("artifactManifest", () => {
  beforeEach(() => { process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-man-")) + "/"; });

  it("reports only the artifacts that exist", () => {
    const dir = process.env.QA_PILOT_OUTPUT + "m1/";
    mkdirSync(dir + "traces", { recursive: true });
    writeFileSync(dir + "plan.md", "# plan");
    writeFileSync(dir + "report.html", "<h1>r</h1>");
    writeFileSync(dir + "traces/checkout-001.zip", "zip");

    const m = artifactManifest("m1");
    expect(m.files).toEqual(expect.arrayContaining(["plan.md", "report.html"]));
    expect(m.files).not.toContain("results.json");
    expect(m.traces).toEqual(["checkout-001.zip"]);
    expect(m.hasReport).toBe(true);
  });

  it("returns an empty manifest for a run with no directory", () => {
    expect(artifactManifest("never-ran")).toEqual({ files: [], traces: [], hasReport: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- manifest`
Expected: FAIL, cannot resolve `../src/runs/manifest.js`.

- [ ] **Step 3: Write `orchestrator/src/runs/manifest.ts`**

```ts
import { existsSync, readdirSync } from "node:fs";
import { outputDir } from "../state.js";

/** The artifacts a run may produce, in the order the UI presents them. */
const KNOWN = [
  "plan.md", "plan.json", "coverage.json", "results.json",
  "heal-log.json", "defects.json", "report.md", "report.html",
  "decisions.jsonl", "events.jsonl",
] as const;

export type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean };

/**
 * Which artifacts actually exist on disk for a run. The UI uses this to enable or disable
 * "Open report" and "Download traces" honestly, instead of offering links that 404 -
 * a partial or failed run legitimately has no report.
 */
export function artifactManifest(runId: string): ArtifactManifest {
  const dir = outputDir(runId);
  if (!existsSync(dir)) return { files: [], traces: [], hasReport: false };
  const files = KNOWN.filter((name) => existsSync(dir + name));
  const traceDir = dir + "traces";
  const traces = existsSync(traceDir) ? readdirSync(traceDir).filter((f) => f.endsWith(".zip")) : [];
  return { files: [...files], traces, hasReport: files.includes("report.html") };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w orchestrator -- manifest`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/runs orchestrator/test/manifest.test.ts
git commit -m "qa-pilot: artifact manifest for a stored run"
```

---

## Task 9: Wire the API - auth, guards, and the run endpoints

**Files:**
- Modify: `orchestrator/src/api.ts` (substantially)
- Modify: `orchestrator/test/api.test.ts`
- Test: `orchestrator/test/ownership.test.ts`

**Interfaces:**
- Consumes: `authRoutes`, `requireUser`, `AuthEnv`, `Store`, `artifactManifest`, `startRun`.
- Produces: `createApi(opts: { start: (input: StartRunInput) => Promise<{ runId: string }> | { runId: string }; store: Store }): Hono`.

**Ruling 1 knock-on.** `userId` is NOT in `RunInputSchema`, so `BodySchema` must not try to omit it. `BodySchema` stays `RunInputSchema.omit({ runId: true, prdText: true })`, and the handler adds `userId` when it builds the `StartRunInput`.

- [ ] **Step 1: Write the failing ownership test**

Create `orchestrator/test/ownership.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";

/** Creates an account with a live session and returns the cookie header for it. */
async function account(store: Store, email: string): Promise<{ id: string; cookie: string }> {
  const user = await store.createUser(email, "unused-in-this-test");
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  return { id: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

describe("run ownership", () => {
  let store: Store;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let runId: string;
  let paths: string[];
  let seq = 0;

  beforeEach(async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-own-")) + "/";
    clearSessionCache();
    store = memoryStore();
    alice = await account(store, "alice@example.com");
    bob = await account(store, "bob@example.com");

    // A UNIQUE id per test, deliberately (Ruling 2). getBus memoises an EventBus per runId
    // in a module-level registry, but QA_PILOT_OUTPUT changes every beforeEach - so reusing
    // one id would leave the bus writing to and replaying from the FIRST test's temp dir.
    runId = `run-alice-${++seq}`;
    await store.insertRun({ id: runId, userId: alice.id, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
    const dir = process.env.QA_PILOT_OUTPUT + runId + "/";
    mkdirSync(dir + "traces", { recursive: true });
    writeFileSync(dir + "report.html", "<h1>alice</h1>");
    writeFileSync(dir + "plan.md", "# alice plan");

    // Terminate the event log, so /events replays and closes instead of leaving a stream
    // pending on live events that will never arrive (Ruling 2).
    getBus(runId).emit({ type: "done", message: "complete" });

    paths = [`/runs/${runId}`, `/events/${runId}`, `/report/${runId}`, `/runs/${runId}/files/plan.md`];
  });

  it("lets the owner through on every run-scoped route", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of paths) {
      const res = await app.request(ORIGIN + p, { headers: { cookie: alice.cookie } });
      expect(res.status, p).toBe(200);
    }
  });

  it("gives another account 404, never 403, so run ids are not confirmed", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of paths) {
      const res = await app.request(ORIGIN + p, { headers: { cookie: bob.cookie } });
      expect(res.status, p).toBe(404);
    }
  });

  it("401s every run-scoped route with no session at all", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of [...paths, "/run", "/runs"]) {
      const res = await app.request(ORIGIN + p, { headers: {} });
      expect(res.status, p).toBe(401);
    }
  });

  it("lists only the caller's runs", async () => {
    await store.insertRun({ id: "run-bob", userId: bob.id, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
    const app = createApi({ start: () => ({ runId: "x" }), store });

    const mine = await app.request(`${ORIGIN}/runs`, { headers: { cookie: alice.cookie } });
    expect((await mine.json()).runs.map((r: { id: string }) => r.id)).toEqual([runId]);

    const theirs = await app.request(`${ORIGIN}/runs`, { headers: { cookie: bob.cookie } });
    expect((await theirs.json()).runs.map((r: { id: string }) => r.id)).toEqual(["run-bob"]);
  });

  it("returns the run record with its artifact manifest", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    const res = await app.request(`${ORIGIN}/runs/${runId}`, { headers: { cookie: alice.cookie } });
    const body = await res.json();
    expect(body.run).toMatchObject({ id: runId, status: "done" });
    expect(body.manifest.hasReport).toBe(true);
    expect(body.manifest.files).toContain("plan.md");
  });

  it("attributes a started run to the caller", async () => {
    const started: Array<{ userId: string; url: string }> = [];
    const app = createApi({ start: (input) => { started.push(input); return { runId: input.runId }; }, store });
    const res = await app.request(`${ORIGIN}/run`, {
      method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:3005", intent: "auth" }),
    });
    expect(res.status).toBe(200);
    expect(started[0].userId).toBe(alice.id);
  });

  it("answers /health without a session", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    const res = await app.request(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- ownership`
Expected: FAIL, `createApi` does not accept `store`.

- [ ] **Step 3: Rewrite `orchestrator/src/api.ts`**

```ts
import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { getBus } from "./events.js";
import { outputDir, RunInputSchema, type StartRunInput } from "./state.js";
import { startRun, newRunId } from "./run.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { authRoutes } from "./auth/routes.js";
import { requireUser, type AuthEnv } from "./auth/middleware.js";
import { artifactManifest } from "./runs/manifest.js";

// userId is not part of RunInputSchema (Ruling 1), so there is nothing to omit for it here;
// the handler supplies it from the session when it builds the StartRunInput.
const BodySchema = RunInputSchema.omit({ runId: true, prdText: true }).extend({ prd: z.string().optional() });

const MIME: Record<string, string> = { html: "text/html", png: "image/png", zip: "application/zip", json: "application/json", md: "text/markdown", ts: "text/plain", jsonl: "text/plain" };

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

export function createApi(opts: {
  start: (input: StartRunInput) => Promise<{ runId: string }> | { runId: string };
  store: Store;
}) {
  const app = new Hono<AuthEnv>();
  const { store } = opts;

  app.use("*", cors({
    // credentials must be allowed for the session cookie to travel on fetch and on
    // EventSource, and an explicit origin is mandatory once credentials are in play.
    origin: [process.env.QA_PILOT_UI_ORIGIN ?? "http://localhost:3000"],
    credentials: true,
  }));

  // Unauthenticated: a reachability probe, so Atlas can be checked before a demo.
  app.get("/health", async (c) => {
    try {
      await store.findUserById("__health_probe__");
      return c.json({ ok: true, mongo: "up" });
    } catch (err) {
      return c.json({ ok: false, mongo: "down", error: (err as Error).message }, 503);
    }
  });

  // Unauthenticated by design: signup and login are how a session is obtained. /auth/me
  // guards itself inside the route group.
  app.route("/auth", authRoutes(store));

  // Everything below requires a session.
  app.use("/run", requireUser(store));
  app.use("/runs", requireUser(store));
  app.use("/runs/*", requireUser(store));
  app.use("/events/*", requireUser(store));
  app.use("/report/*", requireUser(store));

  /**
   * Resolves a run the caller is allowed to see, or null. A run owned by somebody else is
   * indistinguishable from one that does not exist: both yield null and therefore 404,
   * so the API never confirms that another account's run id is real.
   */
  async function ownedRun(runId: string, userId: string): Promise<RunRecord | null> {
    if (!isValidRunId(runId)) return null;
    const rec = await store.getRun(runId);
    return rec && rec.userId === userId ? rec : null;
  }

  app.post("/run", async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { prd, ...rest } = parsed.data;
    const { runId } = await opts.start({ ...rest, runId: newRunId(), prdText: prd, userId: c.get("user").id });
    return c.json({ runId });
  });

  app.get("/runs", async (c) => {
    return c.json({ runs: await store.listRuns(c.get("user").id) });
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await ownedRun(runId, c.get("user").id);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ run, manifest: artifactManifest(runId) });
  });

  app.get("/events/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    const bus = getBus(runId);
    return streamSSE(c, async (stream) => {
      let id = 0;
      let finished = false;
      for (const e of bus.replay()) {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) });
        if (e.type === "done") finished = true;
      }
      if (finished) return;
      await new Promise<void>((resolveStream) => {
        const unsub = bus.subscribe((e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) }).catch(() => { unsub(); resolveStream(); });
          if (e.type === "done") { unsub(); resolveStream(); }
        });
        stream.onAbort(() => { unsub(); resolveStream(); });
      });
    });
  });

  app.get("/report/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.text("not found", 404);
    const path = outputDir(runId) + "report.html";
    if (!existsSync(path)) return c.text("report not ready", 404);
    return c.html(readFileSync(path, "utf8"));
  });

  app.get("/runs/:runId/files/*", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.text("not found", 404);
    const root = resolve(outputDir(runId));
    const rel = c.req.path.split("/files/")[1] ?? "";
    const path = resolve(root, decodeURIComponent(rel));
    const relPath = relative(root, path);
    if (relPath === "" || relPath.startsWith("..") || isAbsolute(relPath) || !existsSync(path)) return c.text("not found", 404);
    const ext = path.split(".").pop() ?? "";
    return c.body(new Uint8Array(readFileSync(path)), 200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("api.ts")) {
  const port = Number(process.env.QA_PILOT_API_PORT ?? 4000);
  const store = await defaultStore();
  const app = createApi({
    store,
    start: async (input) => {
      const { runId, done } = await startRun(input);
      done.catch(() => {});
      return { runId };
    },
  });
  serve({ fetch: app.fetch, port }, () => console.log(`qa-pilot api on http://localhost:${port}`));
}
```

Also drop the now-stale note about omitting `userId`: three things to be careful about here.

The `/report/:runId` and `/runs/:runId/files/*` guards keep `isValidRunId` inside `ownedRun`, so the existing 400-versus-404 behaviour for a malformed id changes to a flat 404. That is intentional and the api test is updated for it in Step 4: a malformed id is no longer distinguishable from an id that is not yours, which is the same reasoning as 404-not-403.

The order of `app.use` matters in Hono. `app.use("/runs", ...)` does not cover `/runs/x`, which is why both `/runs` and `/runs/*` are registered.

- [ ] **Step 4: Update `orchestrator/test/api.test.ts`**

Every existing assertion about traversal is kept. Two changes are needed: the requests now carry a session, and the runs being probed must exist in the store and be owned by the caller. That second point is what keeps these tests meaningful - if the run record were missing, `ownedRun` would 404 first and the traversal guard would never be reached, so the test would pass without testing anything.

Replace the whole file with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";

let store: Store;
let cookie: string;
let userId: string;

/** Registers a run in the store so ownership passes and the route's own guards are what gets tested. */
async function own(runId: string): Promise<void> {
  await store.insertRun({ id: runId, userId, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
}

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  const user = await store.createUser("api@example.com", "unused");
  userId = user.id;
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  cookie = `${SESSION_COOKIE}=${token}`;
});

describe("api", () => {
  it("validates POST /run and returns a runId", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-")) + "/";
    const started: unknown[] = [];
    const app = createApi({ store, start: (input) => { started.push(input); return { runId: input.runId }; } });
    const headers = { cookie, "content-type": "application/json" };

    const bad = await app.request(`${ORIGIN}/run`, { method: "POST", body: JSON.stringify({ url: "nope" }), headers });
    expect(bad.status).toBe(400);

    const ok = await app.request(`${ORIGIN}/run`, { method: "POST", body: JSON.stringify({ url: "http://localhost:3005", intent: "auth" }), headers });
    expect(ok.status).toBe(200);
    const { runId } = await ok.json();
    expect(runId).toMatch(/^run-/);
    expect(started).toHaveLength(1);
  });

  it("replays events over SSE and serves the report", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api2-")) + "/";
    const bus = getBus("api-r1");
    bus.log("planner", "hello");
    bus.emit({ type: "done", message: "complete" });
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r1", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r1/report.html", "<h1>ok</h1>");
    await own("api-r1");

    const app = createApi({ store, start: () => ({ runId: "x" }) });
    const res = await app.request(`${ORIGIN}/events/api-r1`, { headers: { cookie } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: agent_log");
    expect(text).toContain("event: done");

    const report = await app.request(`${ORIGIN}/report/api-r1`, { headers: { cookie } });
    expect(report.status).toBe(200);
    expect(await report.text()).toContain("<h1>ok</h1>");

    // Owned, but the file is absent: "report not ready" rather than a 404 for the run.
    await own("api-r1-noreport");
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r1-noreport", { recursive: true });
    const notReady = await app.request(`${ORIGIN}/report/api-r1-noreport`, { headers: { cookie } });
    expect(notReady.status).toBe(404);
    expect(await notReady.text()).toBe("report not ready");

    // Not a run of ours at all.
    expect((await app.request(`${ORIGIN}/report/missing`, { headers: { cookie } })).status).toBe(404);
  });

  it("serves run files and blocks path traversal", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api3-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots/step1.png", "fake-png-bytes");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "secret.txt", "top secret");
    await own("api-r2");

    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const file = await app.request(`${ORIGIN}/runs/api-r2/files/screenshots/step1.png`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(await file.text()).toBe("fake-png-bytes");

    expect((await app.request(`${ORIGIN}/runs/api-r2/files/nope.png`, { headers: { cookie } })).status).toBe(404);
    // The run IS owned, so this exercises the traversal guard rather than the ownership check.
    expect((await app.request(`${ORIGIN}/runs/api-r2/files/..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404);
  });

  it("rejects sibling-run traversal via a shared runId prefix", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api4-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "run-2026-victim", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "run-2026-victim/report.html", "<h1>victim</h1>");
    // Both runs are owned by the caller, so ownership cannot be what makes the traversal fail.
    await own("run-");
    await own("run-2026-victim");

    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const traversal = await app.request(`${ORIGIN}/runs/run-/files/..%2Frun-2026-victim%2Freport.html`, { headers: { cookie } });
    expect(traversal.status).toBe(404);

    const positive = await app.request(`${ORIGIN}/runs/run-2026-victim/files/report.html`, { headers: { cookie } });
    expect(positive.status).toBe(200);
    expect(await positive.text()).toBe("<h1>victim</h1>");
  });

  it("404s a malformed runId on every run-scoped route", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api5-")) + "/";
    const app = createApi({ store, start: () => ({ runId: "x" }) });
    // Previously 400 "invalid runId". Now a malformed id is indistinguishable from one
    // that is not yours, for the same reason ownership failures are 404 and not 403.
    for (const p of ["/events/..%2Fetc", "/report/..%2Fetc", "/runs/..%2F/files/x"]) {
      expect((await app.request(ORIGIN + p, { headers: { cookie } })).status, p).toBe(404);
    }
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w orchestrator -- ownership api`
Expected: PASS, 7 ownership tests and 5 api tests.

Run: `npm test -w orchestrator`
Expected: everything passes except that `src/cli.ts` still typechecks badly; the suite itself is green.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/api.ts orchestrator/test/api.test.ts orchestrator/test/ownership.test.ts
git commit -m "qa-pilot: require a session on the API and scope every run route to its owner"
```

---

## Task 10: The CLI's reserved account

**Files:**
- Modify: `orchestrator/src/cli.ts`
- Create: `orchestrator/src/auth/local-account.ts`
- Test: `orchestrator/test/local-account.test.ts`

**Interfaces:**
- Consumes: `Store`, `UNUSABLE_PASSWORD_HASH`.
- Produces: `LOCAL_ACCOUNT_EMAIL: "local@qa-pilot"`, `ensureLocalUser(store: Store): Promise<User>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { ensureLocalUser, LOCAL_ACCOUNT_EMAIL } from "../src/auth/local-account.js";
import { verifyPassword } from "../src/auth/password.js";

describe("ensureLocalUser", () => {
  it("creates the account once and returns the same one afterwards", async () => {
    const store = memoryStore();
    const first = await ensureLocalUser(store);
    const second = await ensureLocalUser(store);
    expect(first.id).toBe(second.id);
    expect(first.email).toBe(LOCAL_ACCOUNT_EMAIL);
  });

  it("stores a hash that no password can ever satisfy", async () => {
    const store = memoryStore();
    await ensureLocalUser(store);
    const found = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
    for (const attempt of ["", "-", "password", "local@qa-pilot"]) {
      expect(await verifyPassword(attempt, found!.passwordHash), attempt).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w orchestrator -- local-account`
Expected: FAIL, cannot resolve `../src/auth/local-account.js`.

- [ ] **Step 3: Write `orchestrator/src/auth/local-account.ts`**

```ts
import type { Store, User } from "../store/types.js";
import { UNUSABLE_PASSWORD_HASH } from "./password.js";

/**
 * Runs started from the CLI still belong to somebody, so they are attributed to this
 * reserved account. It carries a hash that verifyPassword cannot parse, so it always
 * returns false and nobody can log in as it through the API. Its address has no dot in
 * the host on purpose: the signup route requires a valid email, so this account cannot
 * be created or claimed from outside.
 */
export const LOCAL_ACCOUNT_EMAIL = "local@qa-pilot";

export async function ensureLocalUser(store: Store): Promise<User> {
  const existing = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
  if (existing) return { id: existing.id, email: existing.email, createdAt: existing.createdAt };
  return store.createUser(LOCAL_ACCOUNT_EMAIL, UNUSABLE_PASSWORD_HASH);
}
```

- [ ] **Step 4: Update `orchestrator/src/cli.ts`**

Add the imports:

```ts
import { defaultStore } from "./store/index.js";
import { ensureLocalUser } from "./auth/local-account.js";
```

Then replace the `startRun(...)` call, which currently begins at line 37, with:

```ts
const store = await defaultStore();
const localUser = await ensureLocalUser(store);

const { done } = await startRun(
  {
    runId,
    userId: localUser.id,
    url,
    intent: values.intent,
    prdText: values.prd ? readFileSync(values.prd, "utf8") : undefined,
    credentials: values.username && values.password ? { username: values.username, password: values.password } : undefined,
    maxFlows: values["max-flows"] ? Number(values["max-flows"]) : 12,
    // RunInputSchema fills maxLlmCalls/maxMinutes defaults at parse time; the
    // static RunInput type resolves those as required, so cast the empty input.
    budget: {} as RunInput["budget"],
  },
  { headless: values.headless || process.env.QA_PILOT_HEADLESS === "1", store },
);
```

The rest of the file, from `let final;` onward, is unchanged.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w orchestrator`
Expected: PASS, whole suite.

Run: `npm run typecheck -w orchestrator`
Expected: clean, no errors anywhere.

- [ ] **Step 6: Verify the API boots against Atlas**

Run: `npm run api` in one terminal, then in another:

```bash
curl -s localhost:4000/health
```
Expected: `{"ok":true,"mongo":"up"}`. If it reports `mongo: "down"`, check `QA_PILOT_MONGO_URL` in `qa-pilot/.env` and the Atlas IP allowlist before going further.

Then confirm the guard is real:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/runs
```
Expected: `401`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/auth/local-account.ts orchestrator/src/cli.ts orchestrator/test/local-account.test.ts
git commit -m "qa-pilot: attribute CLI runs to a reserved local account"
```

---

## Task 11: Design tokens

**Files:**
- Modify: `ui/app/globals.css` (replaced wholesale)
- Modify: `ui/app/layout.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the Tailwind utility names every later UI task uses: `bg-app bg-surface bg-inset bg-console`, `text-fg text-muted text-subtle`, `border-line border-line-strong`, `bg-accent text-accent hover:bg-accent-hover bg-accent-tint`, `text-pass text-fail text-flaky text-defect text-env text-human`, and the radius scale `rounded-input rounded-box rounded-card`.

- [ ] **Step 1: Replace `ui/app/globals.css`**

```css
@import "tailwindcss";

/*
 * One place for every colour and radius in the app. Before this file existed the
 * components carried literals like neutral-950 and amber-500 inline, which is why the
 * dark and light halves of the old UI never agreed with each other.
 */
@theme {
  --color-app: #f7f7f5;
  --color-surface: #ffffff;
  --color-inset: #f1f1ee;
  --color-console: #1c1c19;

  --color-line: #e7e6e2;
  --color-line-strong: #d8d7d2;

  --color-fg: #1b1b19;
  --color-muted: #85857d;
  --color-subtle: #a8a8a0;

  --color-accent: #2f6b4f;
  --color-accent-hover: #275a43;
  --color-accent-tint: #e8f3ec;
  --color-accent-fg: #ffffff;

  /*
   * Status colours. Brand green and "passed" green are deliberately different hues, but
   * nothing in the UI may rely on hue alone: every status renders an icon and a word.
   */
  --color-pass: #16a34a;
  --color-fail: #c2413a;
  --color-flaky: #b5761f;
  --color-defect: #a1201c;
  --color-env: #6b6b63;
  --color-human: #6d4aa8;

  --radius-input: 0.5rem;
  --radius-box: 0.75rem;
  --radius-card: 1rem;

  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

/*
 * The old file set `font-family: Arial, Helvetica, sans-serif` here, which overrode the
 * Geist variables layout.tsx goes to the trouble of loading. The app was never actually
 * rendering in the font it downloaded.
 */
body {
  background: var(--color-app);
  color: var(--color-fg);
  font-family: var(--font-sans), system-ui, sans-serif;
}

/* A single visible focus treatment, so keyboard navigation is never invisible. */
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Trim `ui/app/layout.tsx` to fonts only**

The shell moves into the route group in Task 16, so the root layout keeps only the font wiring and the metadata:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "qa-pilot",
  description: "Live view of qa-pilot autonomous test-orchestration runs",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-app text-fg">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Verify the tokens compile**

Run: `npm run build -w ui`
Expected: the build fails only on `app/page.tsx`, which still imports the old components and is deleted in Task 16. If it fails inside `globals.css`, a token name is malformed.

- [ ] **Step 4: Commit**

```bash
git add ui/app/globals.css ui/app/layout.tsx
git commit -m "qa-pilot ui: design tokens, and stop overriding the Geist font with Arial"
```

---

## Task 12: Extract the view-model logic and put it under test

**Files:**
- Create: `ui/lib/derive.ts`
- Create: `ui/vitest.config.ts`
- Create: `ui/test/derive.test.ts`
- Modify: `ui/package.json`
- Modify: `package.json` (root `test` script)

**Interfaces:**
- Consumes: `RunEvent` from `ui/lib/events.ts`.
- Produces: `NODES`, `pipelineState(events): NodeState[]`, `testRows(events): TestRow[]`, `tally(rows): { passed: number; failed: number }`, `decisionRows(events): DecisionRow[]`, `latestScreenshotPath(events, runId): string | null`, `isDone(events): boolean`, `feedRows(events): RunEvent[]`.

This task exists because the only real logic in the UI currently lives inline inside JSX in `Pipeline.tsx`, `Results.tsx`, and `Decisions.tsx`. Extracting it and pinning it with tests **before** the components are rebuilt is what stops a visual restructure from silently becoming a behavioural one.

- [ ] **Step 1: Add Vitest to the ui workspace**

```bash
npm install -D vitest -w ui
```

Add to `ui/package.json` scripts: `"test": "vitest run"`.

Change the root `package.json` test script to:

```json
"test": "npm run test -w orchestrator -w targets/mini-shop -w ui"
```

Create `ui/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // Mirrors the "@/*" path alias in tsconfig.json so the tests import the same way the app does.
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
});
```

- [ ] **Step 2: Write the failing test**

Create `ui/test/derive.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pipelineState, testRows, tally, decisionRows, latestScreenshotPath, isDone, feedRows, NODES } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

const at = "2026-09-04T12:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ type: "agent_log", runId: "run-1", at, ...e });

describe("pipelineState", () => {
  it("returns every node in pipeline order, all pending for an empty run", () => {
    const state = pipelineState([]);
    expect(state.map((n) => n.node)).toEqual([...NODES]);
    expect(state.every((n) => n.visits === 0 && !n.active)).toBe(true);
  });

  it("marks the most recently started node active and counts revisits", () => {
    const state = pipelineState([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),    ev({ type: "node_end", node: "plan" }),
      ev({ type: "node_start", node: "plan" }),
    ]);
    const byNode = Object.fromEntries(state.map((n) => [n.node, n]));
    expect(byNode.explore).toMatchObject({ visits: 1, active: false });
    expect(byNode.plan).toMatchObject({ visits: 2, active: true });
    expect(byNode.report).toMatchObject({ visits: 0, active: false });
  });

  it("clears the active node once the run is done", () => {
    const state = pipelineState([ev({ type: "node_start", node: "report" }), ev({ type: "done" })]);
    expect(state.every((n) => !n.active)).toBe(true);
  });
});

describe("testRows and tally", () => {
  it("merges a status event and a later classification for the same test", () => {
    const rows = testRows([
      ev({ type: "test_result", data: { id: "auth-001", status: "passed" } }),
      ev({ type: "test_result", data: { id: "checkout-001", status: "failed" } }),
      ev({ type: "test_result", data: { test: "checkout-001", class: "defect", confidence: 0.87 } }),
    ]);
    expect(rows).toEqual([
      { id: "auth-001", status: "passed" },
      { id: "checkout-001", status: "failed", cls: "defect", conf: 0.87 },
    ]);
    expect(tally(rows)).toEqual({ passed: 1, failed: 1 });
  });

  it("keeps the latest status when a test is rerun", () => {
    const rows = testRows([
      ev({ type: "test_result", data: { id: "flaky-001", status: "failed" } }),
      ev({ type: "test_result", data: { id: "flaky-001", status: "passed" } }),
    ]);
    expect(rows).toEqual([{ id: "flaky-001", status: "passed" }]);
    expect(tally(rows)).toEqual({ passed: 1, failed: 0 });
  });

  it("defaults a classification with no prior status to failed", () => {
    const rows = testRows([ev({ type: "test_result", data: { test: "x-1", class: "script", confidence: 0.4 } })]);
    expect(rows).toEqual([{ id: "x-1", status: "failed", cls: "script", conf: 0.4 }]);
  });

  it("ignores events that are not test results", () => {
    expect(testRows([ev({ type: "agent_log", message: "hi" })])).toEqual([]);
  });
});

describe("decisionRows", () => {
  it("returns decisions in order with their evidence", () => {
    const rows = decisionRows([
      ev({ type: "decision", data: { node: "evaluate_coverage", reason: "score 0.62 below 0.75", evidence: ["missing_negative: login"], next: "plan", at } }),
      ev({ type: "agent_log", message: "noise" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node: "evaluate_coverage", next: "plan" });
    expect(rows[0].evidence).toEqual(["missing_negative: login"]);
  });

  it("tolerates a decision with no evidence array", () => {
    const rows = decisionRows([ev({ type: "decision", data: { node: "classify", reason: "r", next: "report", at } })]);
    expect(rows[0].evidence).toEqual([]);
  });
});

describe("latestScreenshotPath", () => {
  it("returns the run-relative path of the newest screenshot", () => {
    const path = latestScreenshotPath([
      ev({ type: "screenshot", data: { path: "/out/run-1/screenshots/a.png" } }),
      ev({ type: "screenshot", data: { path: "/out/run-1/screenshots/b.png" } }),
    ], "run-1");
    expect(path).toBe("screenshots/b.png");
  });

  it("returns null with no screenshots, and for a path that does not contain the run id", () => {
    expect(latestScreenshotPath([], "run-1")).toBeNull();
    expect(latestScreenshotPath([ev({ type: "screenshot", data: { path: "/elsewhere/a.png" } })], "run-1")).toBeNull();
  });
});

describe("isDone and feedRows", () => {
  it("detects the done event", () => {
    expect(isDone([])).toBe(false);
    expect(isDone([ev({ type: "done" })])).toBe(true);
  });

  it("keeps only log and error lines, newest last, capped at 300", () => {
    const many = Array.from({ length: 400 }, (_, i) => ev({ type: "agent_log", message: `m${i}` }));
    const rows = feedRows([...many, ev({ type: "error", message: "boom" }), ev({ type: "screenshot" })]);
    expect(rows).toHaveLength(300);
    expect(rows.at(-1)!.message).toBe("boom");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w ui`
Expected: FAIL, cannot resolve `@/lib/derive`.

- [ ] **Step 4: Write `ui/lib/derive.ts`**

```ts
import type { RunEvent } from "./events";

/** The pipeline nodes, in the order the strip renders them. */
export const NODES = ["explore", "plan", "evaluate_coverage", "generate", "run", "classify", "heal", "report"] as const;
export type NodeName = (typeof NODES)[number];

export type NodeState = { node: NodeName; visits: number; active: boolean };
export type TestRow = { id: string; status: string; cls?: string; conf?: number };
export type DecisionRow = { node: string; reason: string; evidence: string[]; next: string };

const FEED_LIMIT = 300;

export function pipelineState(events: RunEvent[]): NodeState[] {
  const visits = new Map<string, number>();
  let active: string | null = null;
  for (const e of events) {
    if (e.type === "node_start" && e.node) {
      visits.set(e.node, (visits.get(e.node) ?? 0) + 1);
      active = e.node;
    }
    if (e.type === "done") active = null;
  }
  return NODES.map((node) => ({ node, visits: visits.get(node) ?? 0, active: active === node }));
}

/**
 * The runner emits `{ id, status }` when a test finishes and the classifier later emits
 * `{ test, class, confidence }` for the ones that failed. Both arrive as `test_result`,
 * keyed differently, and have to be merged per test id. A classification with no prior
 * status can only describe a failure, so it defaults to failed.
 */
export function testRows(events: RunEvent[]): TestRow[] {
  const rows = new Map<string, TestRow>();
  for (const e of events) {
    if (e.type !== "test_result") continue;
    const d = e.data as { id?: string; status?: string; test?: string; class?: string; confidence?: number };
    if (d.id && d.status) {
      rows.set(d.id, { ...(rows.get(d.id) ?? { id: d.id, status: d.status }), id: d.id, status: d.status });
    }
    if (d.test && d.class) {
      const existing = rows.get(d.test) ?? { id: d.test, status: "failed" };
      rows.set(d.test, { ...existing, cls: d.class, conf: d.confidence });
    }
  }
  return [...rows.values()];
}

export function tally(rows: TestRow[]): { passed: number; failed: number } {
  const passed = rows.filter((r) => r.status === "passed").length;
  return { passed, failed: rows.length - passed };
}

export function decisionRows(events: RunEvent[]): DecisionRow[] {
  return events
    .filter((e) => e.type === "decision")
    .map((e) => {
      const d = e.data as Partial<DecisionRow>;
      return { node: d.node ?? "", reason: d.reason ?? "", evidence: d.evidence ?? [], next: d.next ?? "" };
    });
}

/**
 * Screenshot events carry an absolute path on the API host. The file route is keyed by a
 * path relative to the run directory, so split on the run id. A path that does not
 * contain the run id cannot be served and yields null rather than a broken image.
 */
export function latestScreenshotPath(events: RunEvent[], runId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "screenshot") continue;
    const path = (e.data as { path?: string } | undefined)?.path;
    if (!path) continue;
    const rel = path.split(`/${runId}/`)[1];
    return rel ?? null;
  }
  return null;
}

export function isDone(events: RunEvent[]): boolean {
  return events.some((e) => e.type === "done");
}

export function feedRows(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.type === "agent_log" || e.type === "error").slice(-FEED_LIMIT);
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w ui`
Expected: PASS, 13 tests.

Run: `npm test` from the repo root
Expected: PASS across orchestrator, mini-shop, and ui.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/derive.ts ui/test ui/vitest.config.ts ui/package.json package.json package-lock.json
git commit -m "qa-pilot ui: extract event-to-view-model logic and cover it with tests"
```

---

## Task 13: The API client, the auth context, and the middleware redirect

**Files:**
- Create: `ui/lib/api.ts`
- Create: `ui/lib/auth.tsx`
- Create: `ui/middleware.ts`
- Modify: `ui/lib/events.ts`

**Interfaces:**
- Consumes: `RunEvent`.
- Produces: `API`, `apiFetch`, `ApiError`, `login`, `signup`, `logout`, `me`, `startRun`, `listRuns`, `getRun`, `fileUrl`, `reportUrl`, types `PublicUser`, `RunRecord`, `ArtifactManifest`, `NewRunInput`; `AuthProvider`, `useUser`.

- [ ] **Step 1: Write `ui/lib/api.ts`**

```ts
"use client";

export const API = process.env.NEXT_PUBLIC_QA_PILOT_API ?? "http://localhost:4000";

export type PublicUser = { id: string; email: string; createdAt: string };
export type RunStatus = "running" | "done" | "partial" | "failed" | "interrupted";

export type RunRecord = {
  id: string; userId: string; url: string; intent?: string; hasPrd: boolean;
  status: RunStatus; startedAt: string; heartbeatAt?: string; finishedAt?: string;
  durationMs?: number; coverageScore?: number; planIterations?: number; flowsTotal?: number;
  testsPassed?: number; testsFailed?: number; healsAccepted?: number; defectsCount?: number;
  llmCalls?: number; partialReason?: string;
};

export type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean };

export type NewRunInput = {
  url: string;
  intent?: string;
  prd?: string;
  credentials?: { username: string; password: string };
  maxFlows?: number;
  budget?: { maxLlmCalls: number; maxMinutes: number };
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Turns the API's error shapes - a string, or zod's issue array - into one readable line. */
function messageFrom(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (Array.isArray(error)) {
    const first = error[0] as { message?: string; path?: unknown[] } | undefined;
    if (first?.message) return first.path?.length ? `${first.path.join(".")}: ${first.message}` : first.message;
  }
  return `request failed (${status})`;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    // The session lives in a cookie set by the API on another port, so every request has
    // to opt in to sending it. Without this the API sees an anonymous caller.
    credentials: "include",
    headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, messageFrom(body, res.status));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const signup = (email: string, password: string) =>
  apiFetch<{ user: PublicUser }>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => r.user);

export const login = (email: string, password: string) =>
  apiFetch<{ user: PublicUser }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => r.user);

export const logout = () => apiFetch<{ ok: true }>("/auth/logout", { method: "POST" });

export const me = () => apiFetch<{ user: PublicUser }>("/auth/me").then((r) => r.user);

export const listRuns = () => apiFetch<{ runs: RunRecord[] }>("/runs").then((r) => r.runs);

export const getRun = (id: string) => apiFetch<{ run: RunRecord; manifest: ArtifactManifest }>(`/runs/${encodeURIComponent(id)}`);

export const startRun = (input: NewRunInput) =>
  apiFetch<{ runId: string }>("/run", { method: "POST", body: JSON.stringify(input) }).then((r) => r.runId);

export const reportUrl = (runId: string) => `${API}/report/${encodeURIComponent(runId)}`;

export const fileUrl = (runId: string, relPath: string) =>
  `${API}/runs/${encodeURIComponent(runId)}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
```

- [ ] **Step 2: Write `ui/lib/auth.tsx`**

```tsx
"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { me, logout as apiLogout, ApiError, type PublicUser } from "./api";

type AuthState = { user: PublicUser | null; loading: boolean; signOut: () => Promise<void> };

const Ctx = createContext<AuthState>({ user: null, loading: true, signOut: async () => {} });

/**
 * Resolves the session against the API rather than trusting the cookie. `middleware.ts`
 * only checks that a cookie is present, so this is the component that actually knows
 * whether the caller is signed in, and it is what has to redirect on a stale cookie.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    me()
      .then((u) => { if (!cancelled) setUser(u); })
      .catch((err) => { if (!cancelled && err instanceof ApiError && err.status === 401) router.replace("/login"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router]);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => {});
    setUser(null);
    router.replace("/login");
  }, [router]);

  return <Ctx.Provider value={{ user, loading, signOut }}>{children}</Ctx.Provider>;
}

export const useUser = () => useContext(Ctx);
```

- [ ] **Step 3: Write `ui/middleware.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "qa_pilot_session";
const PUBLIC = ["/login", "/signup"];

/**
 * A convenience, not a security boundary. It only checks that the cookie exists, so a
 * forged value gets past it and is then rejected by the API with a 401, which
 * AuthProvider turns into a redirect.
 *
 * This works because cookies are not scoped by port: the API on :4000 sets the cookie
 * for host "localhost", so requests to the Next server on :3000 carry it. If the API and
 * the UI are ever served from different hostnames this stops firing, and the auth gate in
 * app/(app)/layout.tsx is what handles it. That gate must therefore stand on its own.
 */
export function middleware(req: NextRequest) {
  const hasCookie = req.cookies.has(SESSION_COOKIE);
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!hasCookie && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (hasCookie && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

- [ ] **Step 4: Update `ui/lib/events.ts`**

Two changes only. Delete the `startRun` function at the bottom, which now lives in `lib/api.ts`, and delete the `API` and `NODES` exports, which now live in `lib/api.ts` and `lib/derive.ts` respectively. Then import `API` and pass credentials to the stream:

```ts
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { API } from "./api";

export type RunEvent = { type: string; runId: string; at: string; node?: string; agent?: string; message?: string; data?: unknown };
```

and change the `EventSource` construction to send the session cookie:

```ts
    // The events route is authenticated, and EventSource sends no cookies cross-origin
    // unless it is told to.
    const es = new EventSource(`${API}/events/${runId}`, { withCredentials: true });
```

Every comment already in that file about Strict Mode, `seenIds`, and the native `error` event stays exactly as it is: that behaviour is unchanged.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p ui/tsconfig.json`
Expected: errors only in `ui/app/page.tsx` and `ui/app/components/*`, which Task 16 deletes.

- [ ] **Step 6: Commit**

```bash
git add ui/lib ui/middleware.ts
git commit -m "qa-pilot ui: API client, auth context, and the login redirect"
```

---

## Task 14: The UI primitives

**Files:**
- Create: `ui/components/ui/Button.tsx`, `Input.tsx`, `Textarea.tsx`, `Checkbox.tsx`, `Segmented.tsx`, `Field.tsx`, `Card.tsx`, `StatusPill.tsx`, `Table.tsx`, `Tabs.tsx`, `Meter.tsx`, `Breadcrumb.tsx`, `EmptyState.tsx`, `Spinner.tsx`, `index.ts`

**Interfaces:**
- Consumes: the tokens from Task 11.
- Produces: `Button({ variant?: "primary" | "outline" | "ghost", size?: "sm" | "md", ...ButtonHTMLAttributes })`, `Input(InputHTMLAttributes)`, `Textarea(TextareaHTMLAttributes)`, `Checkbox({ checked, onChange, label, help })`, `Segmented<T>({ options: {value: T, label: string}[], value, onChange })`, `Field({ label, required?, help?, children })`, `Card({ title?, actions?, children, padded? })`, `CardRow({ children })`, `StatusPill({ status })`, `Table`/`Th`/`Td`/`Tr`, `Tabs({ tabs: {id, label, badge?}[], active, onChange })`, `Meter({ value, max?, label? })`, `Breadcrumb({ items: {label, href?}[] })`, `EmptyState({ title, body, action? })`, `Spinner({ size? })`.

- [ ] **Step 1: Write `ui/components/ui/Button.tsx`**

```tsx
import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/40 disabled:cursor-not-allowed",
  outline: "bg-surface text-fg border border-line-strong hover:bg-inset disabled:text-subtle",
  ghost: "text-muted hover:bg-inset hover:text-fg",
} as const;

const SIZES = { sm: "h-8 px-3 text-sm", md: "h-10 px-5 text-sm" } as const;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    />
  );
}
```

- [ ] **Step 2: Write `Input.tsx` and `Textarea.tsx`**

```tsx
import type { InputHTMLAttributes } from "react";

const BASE = "w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none disabled:bg-inset";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${BASE} h-10 ${className}`} />;
}
```

```tsx
import type { TextareaHTMLAttributes } from "react";

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={`w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none ${className}`}
    />
  );
}
```

- [ ] **Step 3: Write `Field.tsx`, `Card.tsx`**

`Field` is the reference's form row: a bold label on the left, the control and its helper text on the right. It stacks on narrow screens.

```tsx
export function Field({
  label, required = false, help, children,
}: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-5 md:grid-cols-[minmax(9rem,14rem)_1fr] md:gap-8">
      <label className="pt-2 text-[15px] font-semibold text-fg">
        {label}
        {required && <span className="ml-1 text-fail" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      <div className="space-y-1.5">
        {children}
        {help && <p className="text-[13px] leading-relaxed text-muted">{help}</p>}
      </div>
    </div>
  );
}
```

```tsx
export function Card({
  title, actions, children, padded = true,
}: { title?: string; actions?: React.ReactNode; children: React.ReactNode; padded?: boolean }) {
  return (
    <section className="rounded-card border border-line bg-surface">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          {title && <h2 className="text-[15px] font-semibold text-fg">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? "px-6 py-2" : ""}>{children}</div>
    </section>
  );
}

/** A form row inside a Card, separated from its neighbours by an inset hairline. */
export function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-line last:border-b-0">{children}</div>;
}
```

- [ ] **Step 4: Write `StatusPill.tsx`**

This is where the "never colour alone" rule is enforced, for both run status and test classification.

```tsx
const STYLES: Record<string, { label: string; icon: string; className: string }> = {
  // run status
  running:     { label: "running",     icon: "◌", className: "bg-accent-tint text-accent" },
  done:        { label: "done",        icon: "✓", className: "bg-accent-tint text-accent" },
  partial:     { label: "partial",     icon: "◑", className: "bg-inset text-flaky" },
  failed:      { label: "failed",      icon: "✕", className: "bg-inset text-fail" },
  interrupted: { label: "interrupted", icon: "⦸", className: "bg-inset text-env" },
  // test outcome
  passed:      { label: "passed",      icon: "✓", className: "bg-inset text-pass" },
  timedOut:    { label: "timed out",   icon: "✕", className: "bg-inset text-fail" },
  skipped:     { label: "skipped",     icon: "–", className: "bg-inset text-env" },
  // classification
  script:      { label: "script",      icon: "✎", className: "bg-inset text-pass" },
  defect:      { label: "defect",      icon: "●", className: "bg-inset text-defect" },
  flaky:       { label: "flaky",       icon: "⚠", className: "bg-inset text-flaky" },
  env:         { label: "env",         icon: "⌁", className: "bg-inset text-env" },
  needs_human: { label: "needs human", icon: "☝", className: "bg-inset text-human" },
};

/**
 * Every status carries an icon and a word, never a bare colour. Brand green and "passed"
 * green are close by design, so hue is not allowed to be the only signal.
 */
export function StatusPill({ status, suffix }: { status: string; suffix?: string }) {
  const style = STYLES[status] ?? { label: status, icon: "•", className: "bg-inset text-muted" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}>
      <span aria-hidden="true">{style.icon}</span>
      {style.label}
      {suffix && <span className="text-muted">{suffix}</span>}
    </span>
  );
}
```

- [ ] **Step 5: Write `Tabs.tsx`, `Segmented.tsx`, `Meter.tsx`, `Table.tsx`, `Breadcrumb.tsx`, `EmptyState.tsx`, `Spinner.tsx`, `Checkbox.tsx`**

```tsx
export function Tabs<T extends string>({
  tabs, active, onChange,
}: { tabs: Array<{ id: T; label: string; badge?: number }>; active: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-full bg-inset p-1">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={t.id === active} onClick={() => onChange(t.id)}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
            t.id === active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && <span className="ml-1.5 text-xs text-subtle">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
```

`Segmented.tsx` is the same control for a form value rather than a view:

```tsx
export function Segmented<T extends string>({
  options, value, onChange,
}: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex w-full gap-1 rounded-input bg-inset p-1">
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={o.value === value}
          className={`flex-1 rounded-[0.375rem] px-3 py-1.5 text-sm font-medium transition-colors ${
            o.value === value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

```tsx
/** The reference's thin green progress bar. `value` and `max` are in the caller's own units. */
export function Meter({ value, max = 1, label }: { value: number; max?: number; label?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="space-y-1">
      {label && <div className="flex justify-between text-xs text-muted"><span>{label}</span><span>{Math.round(pct)}%</span></div>}
      <div className="h-1.5 overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
```

```tsx
export function Table({ children }: { children: React.ReactNode }) {
  // Wide content scrolls inside its own container so the page body never scrolls sideways.
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => (
  <th className={`border-b border-line px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted ${className}`}>{children}</th>
);
export const Td = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => (
  <td className={`border-b border-line px-4 py-3 align-middle text-fg ${className}`}>{children}</td>
);
```

```tsx
import Link from "next/link";

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-subtle" aria-hidden="true">›</span>}
          {item.href ? (
            <Link href={item.href} className="text-muted hover:text-fg">{item.label}</Link>
          ) : (
            <span className="font-medium text-fg">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
```

```tsx
export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      {action}
    </div>
  );
}
```

```tsx
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status" aria-label="loading" style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-line border-t-accent"
    />
  );
}
```

```tsx
export function Checkbox({
  checked, onChange, label, help,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex cursor-pointer gap-3">
      <input
        type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-[18px] shrink-0 cursor-pointer rounded-[4px] border-line-strong accent-accent"
      />
      <span className="space-y-1">
        <span className="block text-[15px] font-semibold text-fg">{label}</span>
        {help && <span className="block text-[13px] leading-relaxed text-muted">{help}</span>}
      </span>
    </label>
  );
}
```

- [ ] **Step 6: Write the barrel `ui/components/ui/index.ts`**

```ts
export { Button } from "./Button";
export { Input } from "./Input";
export { Textarea } from "./Textarea";
export { Checkbox } from "./Checkbox";
export { Segmented } from "./Segmented";
export { Field } from "./Field";
export { Card, CardRow } from "./Card";
export { StatusPill } from "./StatusPill";
export { Table, Th, Td } from "./Table";
export { Tabs } from "./Tabs";
export { Meter } from "./Meter";
export { Breadcrumb } from "./Breadcrumb";
export { EmptyState } from "./EmptyState";
export { Spinner } from "./Spinner";
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit -p ui/tsconfig.json`
Expected: errors only in the old `app/page.tsx` and `app/components/*`.

```bash
git add ui/components/ui
git commit -m "qa-pilot ui: primitives matching the reference design language"
```

---

## Task 15: The login and signup screens

**Files:**
- Create: `ui/app/login/page.tsx`
- Create: `ui/app/signup/page.tsx`
- Create: `ui/components/auth/AuthForm.tsx`

**Interfaces:**
- Consumes: `Button`, `Input`, `login`, `signup`, `ApiError`.
- Produces: `AuthForm({ mode }: { mode: "login" | "signup" })`.

- [ ] **Step 1: Write `ui/components/auth/AuthForm.tsx`**

Both screens are the same form with different copy and a different call, so they share one component.

```tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Spinner } from "@/components/ui";
import { login, signup } from "@/lib/api";

const COPY = {
  login: { title: "Sign in", cta: "Sign in", altText: "Need an account?", altLabel: "Create one", altHref: "/signup" },
  signup: { title: "Create an account", cta: "Create account", altText: "Already have an account?", altLabel: "Sign in", altHref: "/login" },
} as const;

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const copy = COPY[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === "login" ? login(email, password) : signup(email, password));
      // The API set the session cookie on this response, so a full navigation is what
      // lets middleware see it on the next request.
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-box bg-accent text-sm font-bold text-white">qp</div>
          <h1 className="text-2xl font-semibold text-fg">{copy.title}</h1>
          <p className="text-sm text-muted">qa-pilot autonomous test orchestration</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-card border border-line bg-surface p-6">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-fg">Email</label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-fg">Password</label>
            <Input
              id="password" type="password" required minLength={8} value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters"
            />
          </div>

          {error && <p role="alert" className="rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? <><Spinner /> working</> : copy.cta}
          </Button>
        </form>

        <p className="text-center text-sm text-muted">
          {copy.altText} <Link href={copy.altHref} className="font-medium text-accent hover:underline">{copy.altLabel}</Link>
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Write the two pages**

`ui/app/login/page.tsx`:

```tsx
import { AuthForm } from "@/components/auth/AuthForm";

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
```

`ui/app/signup/page.tsx`:

```tsx
import { AuthForm } from "@/components/auth/AuthForm";

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/app/login ui/app/signup ui/components/auth
git commit -m "qa-pilot ui: login and signup screens"
```

---

## Task 16: The app shell

**Files:**
- Create: `ui/app/(app)/layout.tsx`
- Create: `ui/components/shell/Sidebar.tsx`
- Create: `ui/components/shell/UserMenu.tsx`
- Create: `ui/components/shell/PageHeader.tsx`
- Delete: `ui/app/page.tsx`, `ui/app/components/Pipeline.tsx`, `Feed.tsx`, `Decisions.tsx`, `Results.tsx`

**Interfaces:**
- Consumes: `AuthProvider`, `useUser`, `Breadcrumb`, `Spinner`.
- Produces: `PageHeader({ crumbs, title, subtitle, actions })`.

- [ ] **Step 1: Delete the old UI**

```bash
git rm ui/app/page.tsx ui/app/components/Pipeline.tsx ui/app/components/Feed.tsx ui/app/components/Decisions.tsx ui/app/components/Results.tsx
```

Their logic already moved to `lib/derive.ts` in Task 12 and is under test there; their markup is replaced in Task 19.

- [ ] **Step 2: Write `ui/components/shell/UserMenu.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@/lib/auth";

export function UserMenu() {
  const { user, signOut } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onDocumentClick); document.removeEventListener("keydown", onEscape); };
  }, [open]);

  const initials = (user?.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-box border border-line bg-surface shadow-lg">
          <button onClick={signOut} className="w-full px-3 py-2 text-left text-sm text-fg hover:bg-inset">Log out</button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-box px-2 py-2 text-left hover:bg-inset"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-white">{initials}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{user?.email ?? "…"}</span>
        <span className="text-subtle" aria-hidden="true">⌃</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write `ui/components/shell/BudgetCard.tsx`**

The mint-tinted card at the foot of the sidebar, in the slot the reference gives its trial
promo and credit meter. The honest analogue here is how much of the LLM budget this
account has spent, which is real information rather than an advert.

```tsx
"use client";
import { useEffect, useState } from "react";
import { Meter } from "@/components/ui";
import { listRuns } from "@/lib/api";

/** The API's default per-run cap, which is what a single run is measured against. */
const PER_RUN_CAP = 200;

export function BudgetCard() {
  const [totals, setTotals] = useState<{ runs: number; calls: number } | null>(null);

  useEffect(() => {
    // Deliberately the same /runs call the Overview page makes. The list is small and
    // per-account, so a second fetch is cheaper than threading shared state through the
    // shell for one card.
    listRuns()
      .then((runs) => setTotals({ runs: runs.length, calls: runs.reduce((n, r) => n + (r.llmCalls ?? 0), 0) }))
      .catch(() => setTotals(null));
  }, []);

  if (!totals) return null;
  const latestRunShare = Math.min(totals.calls, PER_RUN_CAP);

  return (
    <div className="space-y-2 rounded-card bg-accent-tint p-3.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-accent">
        <span aria-hidden="true">✦</span> LLM budget
      </p>
      <p className="text-[12px] leading-relaxed text-accent/80">
        {totals.calls} calls across {totals.runs} {totals.runs === 1 ? "run" : "runs"}.
      </p>
      <Meter value={latestRunShare} max={PER_RUN_CAP} />
      <p className="text-[11px] text-accent/70">{PER_RUN_CAP} calls is the default cap per run.</p>
    </div>
  );
}
```

- [ ] **Step 4: Write `ui/components/shell/Sidebar.tsx`**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";
import { BudgetCard } from "./BudgetCard";

const NAV = [
  { href: "/", label: "Overview", icon: "⌂" },
  { href: "/runs/new", label: "New run", icon: "＋" },
] as const;

const REFERENCE = [
  { href: "https://github.com/PradeepKundekar0101/100xBuilders/blob/main/qa-pilot/ARCHITECTURE.md", label: "Architecture" },
  { href: "https://github.com/PradeepKundekar0101/100xBuilders/blob/main/qa-pilot/README.md", label: "Documentation" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-app">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex size-8 items-center justify-center rounded-box bg-accent text-xs font-bold text-white">qp</span>
        <span className="text-[15px] font-semibold text-fg">qa-pilot</span>
      </div>

      <nav className="space-y-0.5 px-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href} href={item.href}
              className={`flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] transition-colors ${
                active ? "bg-accent-tint font-medium text-accent" : "text-fg hover:bg-inset"
              }`}
            >
              <span className="w-4 text-center text-muted" aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <p className="px-4 pb-1 pt-6 text-xs font-medium text-subtle">Reference</p>
      <nav className="space-y-0.5 px-2">
        {REFERENCE.map((item) => (
          <a
            key={item.href} href={item.href} target="_blank" rel="noreferrer"
            className="flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] text-fg hover:bg-inset"
          >
            <span className="w-4 text-center text-muted" aria-hidden="true">▤</span>
            <span className="flex-1">{item.label}</span>
            <span className="text-subtle" aria-hidden="true">↗</span>
          </a>
        ))}
      </nav>

      <div className="mt-auto space-y-2 p-3">
        <BudgetCard />
        <UserMenu />
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Write `ui/components/shell/PageHeader.tsx`**

```tsx
import { Breadcrumb } from "@/components/ui";

export function PageHeader({
  crumbs, title, subtitle, actions,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <Breadcrumb items={crumbs} />
        {actions}
      </div>
      {title && (
        <div className="space-y-2 px-8 pb-2 pt-8">
          <h1 className="text-[28px] font-semibold leading-tight text-fg">{title}</h1>
          {subtitle && <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{subtitle}</p>}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Write `ui/app/(app)/layout.tsx`**

```tsx
"use client";
import { AuthProvider, useUser } from "@/lib/auth";
import { Sidebar } from "@/components/shell/Sidebar";
import { Spinner } from "@/components/ui";

/**
 * The real auth gate. middleware.ts only checks that a cookie exists, so a stale or
 * forged cookie reaches here; AuthProvider resolves it against the API and redirects on
 * a 401. Nothing inside the shell renders until that has settled, so a signed-out visitor
 * never sees run data flash on screen.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app">
        <Spinner size={22} />
      </div>
    );
  }
  if (!user) return null;
  return (
    <div className="flex min-h-screen bg-app">
      <Sidebar />
      <div className="min-w-0 flex-1 bg-surface">{children}</div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}
```

- [ ] **Step 7: Verify the shell renders**

Run `npm run api` and `npm run ui`, then open `http://localhost:3000`.
Expected: redirected to `/login`. Create an account, land on `/` with the sidebar visible. The Overview page itself is not built until Task 17, so a "not found" body inside the shell at this point is correct.

- [ ] **Step 8: Commit**

```bash
git add ui/app ui/components/shell
git commit -m "qa-pilot ui: app shell with sidebar, breadcrumbs, and the auth gate"
```

---

## Task 17: The Overview dashboard

**Files:**
- Create: `ui/app/(app)/page.tsx`
- Create: `ui/components/runs/StatCard.tsx`
- Create: `ui/components/runs/RunTable.tsx`
- Create: `ui/lib/format.ts`

**Interfaces:**
- Consumes: `listRuns`, `RunRecord`, primitives, `PageHeader`.
- Produces: `StatCard({ label, value, hint? })`, `RunTable({ runs })`, `relativeTime(iso)`, `formatDuration(ms)`, `hostOf(url)`.

- [ ] **Step 1: Write `ui/lib/format.ts`**

```ts
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 1000], ["minute", 60_000], ["hour", 3_600_000], ["day", 86_400_000],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 minutes ago". Falls back to a date once a run is more than a week old. */
export function relativeTime(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "unknown";
  if (delta > 7 * 86_400_000) return new Date(iso).toLocaleDateString();
  let chosen: [Intl.RelativeTimeFormatUnit, number] = UNITS[0];
  for (const unit of UNITS) if (delta >= unit[1]) chosen = unit;
  return rtf.format(-Math.round(delta / chosen[1]), chosen[0]);
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes === 0 ? `${totalSeconds}s` : `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

/** The target's host and port, for a table cell that must stay narrow. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
```

- [ ] **Step 2: Write `ui/components/runs/StatCard.tsx`**

```tsx
export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold text-fg">{value}</p>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Write `ui/components/runs/RunTable.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { Table, Th, Td, StatusPill, Meter } from "@/components/ui";
import { relativeTime, formatDuration, hostOf } from "@/lib/format";
import type { RunRecord } from "@/lib/api";

export function RunTable({ runs }: { runs: RunRecord[] }) {
  const router = useRouter();
  return (
    <Table>
      <thead>
        <tr>
          <Th>Status</Th><Th>Target</Th><Th>Started</Th><Th>Duration</Th>
          <Th className="w-32">Coverage</Th><Th>Tests</Th><Th>Defects</Th><Th>Heals</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr
            key={run.id} onClick={() => router.push(`/runs/${run.id}`)}
            className="cursor-pointer transition-colors hover:bg-inset"
          >
            <Td><StatusPill status={run.status} /></Td>
            <Td>
              <span className="font-mono text-[13px]">{hostOf(run.url)}</span>
              {run.intent && <span className="ml-2 text-[13px] text-muted">{run.intent}</span>}
            </Td>
            <Td className="whitespace-nowrap text-muted">{relativeTime(run.startedAt)}</Td>
            <Td className="whitespace-nowrap text-muted">{formatDuration(run.durationMs)}</Td>
            <Td>
              {run.coverageScore === undefined
                ? <span className="text-subtle">-</span>
                : <Meter value={run.coverageScore} label={run.coverageScore.toFixed(2)} />}
            </Td>
            <Td className="whitespace-nowrap">
              {run.testsPassed === undefined ? <span className="text-subtle">-</span> : (
                <span className="font-mono text-[13px]">
                  <span className="text-pass">{run.testsPassed}</span>
                  <span className="text-subtle"> / </span>
                  <span className={run.testsFailed ? "text-fail" : "text-muted"}>{run.testsFailed ?? 0}</span>
                </span>
              )}
            </Td>
            <Td className={run.defectsCount ? "font-medium text-defect" : "text-subtle"}>{run.defectsCount ?? "-"}</Td>
            <Td className="text-muted">{run.healsAccepted ?? "-"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
```

- [ ] **Step 4: Write `ui/app/(app)/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { StatCard } from "@/components/runs/StatCard";
import { RunTable } from "@/components/runs/RunTable";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import { listRuns, type RunRecord } from "@/lib/api";

function stats(runs: RunRecord[]) {
  const finished = runs.filter((r) => r.testsPassed !== undefined);
  const passed = finished.reduce((n, r) => n + (r.testsPassed ?? 0), 0);
  const failed = finished.reduce((n, r) => n + (r.testsFailed ?? 0), 0);
  const total = passed + failed;
  return {
    runs: runs.length,
    passRate: total === 0 ? "-" : `${Math.round((passed / total) * 100)}%`,
    defects: runs.reduce((n, r) => n + (r.defectsCount ?? 0), 0),
    heals: runs.reduce((n, r) => n + (r.healsAccepted ?? 0), 0),
    total,
  };
}

export default function OverviewPage() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns).catch((err) => setError((err as Error).message));
  }, []);

  const s = runs ? stats(runs) : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Overview" }]}
        title="Overview"
        subtitle="Every run this account has started, newest first. Open one to replay its pipeline, decisions, and report."
        actions={<Link href="/runs/new"><Button size="sm">Start a run</Button></Link>}
      />

      <div className="space-y-6 px-8 py-6">
        {error && <p role="alert" className="rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}

        {s && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Runs" value={String(s.runs)} />
            <StatCard label="Pass rate" value={s.passRate} hint={s.total ? `${s.total} tests executed` : undefined} />
            <StatCard label="Defects found" value={String(s.defects)} />
            <StatCard label="Heals applied" value={String(s.heals)} />
          </div>
        )}

        <Card title="Recent runs" padded={false}>
          {runs === null ? (
            <div className="flex justify-center py-14"><Spinner size={22} /></div>
          ) : runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              body="Point qa-pilot at a URL and it explores the app, plans tests, generates them, runs them, and repairs what breaks."
              action={<Link href="/runs/new"><Button>Start your first run</Button></Link>}
            />
          ) : (
            <RunTable runs={runs} />
          )}
        </Card>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Verify**

Reload `http://localhost:3000`.
Expected: the four stat cards and an empty-state card reading "No runs yet", since nothing has been recorded for this account.

- [ ] **Step 6: Commit**

```bash
git add ui/app/\(app\)/page.tsx ui/components/runs ui/lib/format.ts
git commit -m "qa-pilot ui: overview dashboard with run history"
```

---

## Task 18: The start-a-run screen

**Files:**
- Create: `ui/app/(app)/runs/new/page.tsx`

**Interfaces:**
- Consumes: `startRun`, `NewRunInput`, primitives, `PageHeader`.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write `ui/app/(app)/runs/new/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, CardRow, Checkbox, Field, Input, Segmented, Spinner, Textarea } from "@/components/ui";
import { startRun } from "@/lib/api";

const DEFAULTS = {
  url: "http://localhost:3005",
  intent: "focus on auth and checkout",
  username: "demo@shop.test",
  password: "demo1234",
};

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export default function NewRunPage() {
  const router = useRouter();
  const [url, setUrl] = useState(DEFAULTS.url);
  const [intent, setIntent] = useState(DEFAULTS.intent);
  const [requiresSignIn, setRequiresSignIn] = useState(true);
  const [username, setUsername] = useState(DEFAULTS.username);
  const [password, setPassword] = useState(DEFAULTS.password);
  const [prdMode, setPrdMode] = useState<"upload" | "paste">("upload");
  const [prd, setPrd] = useState("");
  const [prdName, setPrdName] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [maxFlows, setMaxFlows] = useState(12);
  const [maxLlmCalls, setMaxLlmCalls] = useState(200);
  const [maxMinutes, setMaxMinutes] = useState(40);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function readPrdFile(file: File) {
    setPrdName(file.name);
    setPrd(await file.text());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const runId = await startRun({
        url,
        intent: intent.trim() || undefined,
        prd: prd.trim() || undefined,
        credentials: requiresSignIn && username && password ? { username, password } : undefined,
        maxFlows,
        budget: { maxLlmCalls, maxMinutes },
      });
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-screen flex-col">
      <PageHeader
        crumbs={[{ label: "Runs", href: "/" }, { label: "New run" }]}
        title="Start a run"
        subtitle="Tell qa-pilot what to test. It explores the app, writes a plan, scores the plan for gaps, generates Playwright tests, runs them, and repairs what breaks."
      />

      <div className="mx-auto w-full max-w-[1040px] flex-1 space-y-6 px-8 pb-32 pt-4">
        <Card title="Target">
          <CardRow>
            <Field label="URL" required help="The URL of the app qa-pilot should test.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com" required />
            </Field>
          </CardRow>
          <CardRow>
            <Field label="Intent" help="Natural-language scoping, for example: focus on auth and checkout. Leave blank to let the planner cover the whole app.">
              <Input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="focus on auth and checkout" />
            </Field>
          </CardRow>
        </Card>

        <Card title="Sign in to the target app">
          <CardRow>
            <div className="space-y-4 py-5">
              <Checkbox
                checked={requiresSignIn} onChange={setRequiresSignIn} label="Require sign in?"
                help="Check this if parts of the app are behind a login. qa-pilot signs in with a test account so it can reach those flows. These credentials are used for the run and are never stored."
              />
              {requiresSignIn && (
                <div className="grid gap-3 pl-[30px] sm:grid-cols-2">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoComplete="off" aria-label="Target app username" />
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password" autoComplete="off" aria-label="Target app password" />
                </div>
              )}
            </div>
          </CardRow>
        </Card>

        <Card title="Add sources">
          <CardRow>
            <Field label="Add sources" help="qa-pilot extracts requirements from the document and maps each one onto a planned flow, then reports the ones nothing covers.">
              <div className="space-y-3">
                <div className="rounded-box border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-[15px] font-semibold text-fg">Product Requirements Doc (PRD)</p>
                      <p className="text-[13px] text-accent">✦ Strongly recommended</p>
                    </div>
                    <Segmented
                      options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste" }]}
                      value={prdMode} onChange={setPrdMode}
                    />
                  </div>

                  <div className="mt-4">
                    {prdMode === "upload" ? (
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-inset">
                        <span aria-hidden="true">↥</span>
                        {prdName ?? "Upload PRD"}
                        <input
                          type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" className="sr-only"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPrdFile(f); }}
                        />
                      </label>
                    ) : (
                      <Textarea
                        value={prd} onChange={(e) => { setPrd(e.target.value); setPrdName(null); }}
                        className="h-32" placeholder="Paste the requirements here"
                      />
                    )}
                  </div>
                </div>
              </div>
            </Field>
          </CardRow>
        </Card>

        <Card
          title="Budget"
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
              {advanced ? "Hide" : "Show"} advanced
            </Button>
          }
        >
          {advanced ? (
            <>
              <CardRow>
                <Field label="Max flows" help="Upper bound on how many flows the planner may produce.">
                  <Input type="number" min={1} value={maxFlows} onChange={(e) => setMaxFlows(Number(e.target.value))} />
                </Field>
              </CardRow>
              <CardRow>
                <Field label="Max LLM calls" help="The run stops and reports partially once this is exceeded.">
                  <Input type="number" min={1} value={maxLlmCalls} onChange={(e) => setMaxLlmCalls(Number(e.target.value))} />
                </Field>
              </CardRow>
              <CardRow>
                <Field label="Max minutes" help="Wall-clock budget for the whole run.">
                  <Input type="number" min={1} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
                </Field>
              </CardRow>
            </>
          ) : (
            <p className="py-5 text-[13px] text-muted">
              {maxFlows} flows, {maxLlmCalls} LLM calls, {maxMinutes} minutes.
            </p>
          )}
        </Card>
      </div>

      {/* Sticky action bar, as in the reference: the primary stays disabled until the URL parses. */}
      <div className="sticky bottom-0 border-t border-line bg-surface/95 px-8 py-4 backdrop-blur">
        {error && <p role="alert" className="mx-auto mb-3 max-w-[1040px] rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}
        <div className="flex justify-center gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/")}>Cancel</Button>
          <Button type="submit" disabled={busy || !isValidUrl(url)}>
            {busy ? <><Spinner /> starting</> : "Start run"}
          </Button>
        </div>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Verify the disabled primary and the reveal**

Open `http://localhost:3000/runs/new`.
Expected: clearing the URL field disables "Start run"; unchecking "Require sign in?" hides the username and password inputs; toggling Upload and Paste swaps the PRD control; "Show advanced" reveals the three budget fields.

- [ ] **Step 3: Commit**

```bash
git add "ui/app/(app)/runs/new"
git commit -m "qa-pilot ui: start-a-run screen with conditional credentials and PRD input"
```

---

## Task 19: The run detail screen

**Files:**
- Create: `ui/components/run/Pipeline.tsx`, `Feed.tsx`, `Decisions.tsx`, `Results.tsx`, `PlanPanel.tsx`, `BrowserCard.tsx`, `SummaryCard.tsx`, `ReportFrame.tsx`, `RunHeader.tsx`
- Create: `ui/app/(app)/runs/[id]/page.tsx`

**Interfaces:**
- Consumes: `useRunEvents`, every function in `lib/derive.ts`, `getRun`, `fileUrl`, `reportUrl`, primitives.
- Produces: nothing consumed elsewhere.

The whole point of this screen is that one component set serves a live run and a finished one. Nothing below branches on "is this replaying": the event stream is the same either way, because `/events/:id` replays `events.jsonl` before it streams.

- [ ] **Step 1: Write `ui/components/run/Pipeline.tsx`**

```tsx
import { pipelineState } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function Pipeline({ events }: { events: RunEvent[] }) {
  const nodes = pipelineState(events);
  return (
    <div className="overflow-x-auto">
      <ol className="flex min-w-max items-center gap-1 py-1">
        {nodes.map((n, i) => {
          const visited = n.visits > 0;
          return (
            <li key={n.node} className="flex items-center gap-1">
              {i > 0 && <span className={`h-px w-6 ${visited ? "bg-accent" : "bg-line"}`} aria-hidden="true" />}
              <span
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  n.active
                    ? "animate-pulse border-accent bg-accent text-white"
                    : visited
                      ? "border-accent-tint bg-accent-tint text-accent"
                      : "border-line bg-surface text-subtle"
                }`}
              >
                <span aria-hidden="true">{n.active ? "◌" : visited ? "✓" : "○"}</span>
                {n.node}
                {n.visits > 1 && <span className="opacity-70">x{n.visits}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
```

- [ ] **Step 2: Write `ui/components/run/Feed.tsx`**

The one dark surface in the app. Log output reads as log output, and the per-agent colour coding would go to mud on white.

```tsx
"use client";
import { useEffect, useRef } from "react";
import { feedRows } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

const COLORS: Record<string, string> = {
  explorer: "text-sky-300", planner: "text-violet-300", evaluator: "text-fuchsia-300",
  runner: "text-neutral-400", classifier: "text-orange-300", healer: "text-emerald-300",
  llm: "text-yellow-200", orchestrator: "text-white",
};

export function Feed({ events }: { events: RunEvent[] }) {
  const end = useRef<HTMLDivElement>(null);
  const rows = feedRows(events);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [rows.length]);

  return (
    <div className="h-full overflow-auto rounded-box bg-console p-3 font-mono text-xs leading-relaxed">
      {rows.length === 0 && <p className="text-neutral-500">waiting for the first agent log…</p>}
      {rows.map((e, i) => {
        const agent = (e.agent ?? "").split(":")[0];
        return (
          <div key={i} className={e.type === "error" ? "text-red-400" : COLORS[agent] ?? "text-neutral-300"}>
            <span className="text-neutral-600">{e.at.slice(11, 19)}</span>{" "}
            <span className="text-neutral-500">[{e.agent ?? "error"}]</span> {e.message}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
```

- [ ] **Step 3: Write `ui/components/run/Decisions.tsx`**

```tsx
import { decisionRows } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function Decisions({ events }: { events: RunEvent[] }) {
  const rows = decisionRows(events);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted">No branch decisions yet.</p>;
  return (
    <ol className="h-full space-y-3 overflow-auto p-1">
      {rows.map((d, i) => (
        <li key={i} className="border-l-2 border-accent pl-3">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <span className="text-fg">{d.node}</span>
            <span className="text-subtle" aria-hidden="true">→</span>
            <span className="text-accent">{d.next}</span>
          </div>
          <p className="mt-0.5 text-sm text-fg">{d.reason}</p>
          {d.evidence.length > 0 && (
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">{d.evidence.slice(0, 4).join(" · ")}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 4: Write `ui/components/run/Results.tsx`**

```tsx
import { testRows, tally } from "@/lib/derive";
import { StatusPill } from "@/components/ui";
import type { RunEvent } from "@/lib/events";

export function Results({ events }: { events: RunEvent[] }) {
  const rows = testRows(events);
  const { passed, failed } = tally(rows);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted">No tests have finished yet.</p>;

  return (
    <div className="h-full overflow-auto p-1">
      <div className="mb-3 flex gap-6 px-1">
        <span className="text-sm"><span className="text-lg font-semibold text-pass">{passed}</span> <span className="text-muted">passed</span></span>
        <span className="text-sm"><span className="text-lg font-semibold text-fail">{failed}</span> <span className="text-muted">failed</span></span>
      </div>
      <ul className="space-y-1">
        {rows.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-box px-1 py-1.5 hover:bg-inset">
            <StatusPill status={t.status} />
            <span className="font-mono text-[13px] text-fg">{t.id}</span>
            {t.cls && <StatusPill status={t.cls} suffix={t.conf?.toFixed(2)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Write `ui/components/run/PlanPanel.tsx` and `ReportFrame.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/api";
import { Spinner } from "@/components/ui";

/** Renders the generated plan.md as text. It is markdown, but showing it verbatim keeps the flow ids, categories and priorities aligned. */
export function PlanPanel({ runId, available }: { runId: string; available: boolean }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    fetch(fileUrl(runId, "plan.md"), { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("plan not available"))))
      .then((t) => { if (!cancelled) setText(t); })
      .catch(() => { if (!cancelled) setText(null); });
    return () => { cancelled = true; };
  }, [runId, available]);

  if (!available) return <p className="p-4 text-sm text-muted">The planner has not written a plan yet.</p>;
  if (text === null) return <div className="flex justify-center p-8"><Spinner /></div>;
  return <pre className="h-full overflow-auto rounded-box bg-inset p-4 font-mono text-xs leading-relaxed text-fg whitespace-pre-wrap">{text}</pre>;
}
```

```tsx
import { reportUrl } from "@/lib/api";

export function ReportFrame({ runId, available }: { runId: string; available: boolean }) {
  if (!available) {
    return <p className="p-4 text-sm text-muted">No report yet. The report is written when the run reaches the report node.</p>;
  }
  return <iframe title="run report" src={reportUrl(runId)} className="h-full w-full rounded-box border border-line bg-white" />;
}
```

- [ ] **Step 6: Write `ui/components/run/BrowserCard.tsx` and `SummaryCard.tsx`**

```tsx
import { fileUrl } from "@/lib/api";
import { Card } from "@/components/ui";
import { latestScreenshotPath } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function BrowserCard({ events, runId }: { events: RunEvent[]; runId: string }) {
  const rel = latestScreenshotPath(events, runId);
  return (
    <Card title="Browser">
      <div className="py-3">
        {rel ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API path, not a static asset Next can optimise
          <img src={fileUrl(runId, rel)} alt="Latest exploration screenshot" className="w-full rounded-box border border-line" />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-box bg-inset text-sm text-muted">no screenshot yet</div>
        )}
      </div>
    </Card>
  );
}
```

```tsx
import { Card, Meter } from "@/components/ui";
import type { RunRecord } from "@/lib/api";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}

export function SummaryCard({ run }: { run: RunRecord }) {
  const budget = 200; // the API's default maxLlmCalls; the run record stores the count, not the cap
  return (
    <Card title="Summary">
      <div className="py-2">
        {run.coverageScore !== undefined && (
          <div className="border-b border-line py-3">
            <Meter value={run.coverageScore} label={`Coverage ${run.coverageScore.toFixed(2)}`} />
          </div>
        )}
        <Row label="Flows planned" value={run.flowsTotal ?? "-"} />
        <Row label="Plan iterations" value={run.planIterations ?? "-"} />
        <Row
          label="Tests"
          value={run.testsPassed === undefined ? "-" : (
            <><span className="text-pass">{run.testsPassed} passed</span>{run.testsFailed ? <span className="text-fail">, {run.testsFailed} failed</span> : null}</>
          )}
        />
        <Row label="Heals accepted" value={run.healsAccepted ?? "-"} />
        <Row label="Defects escalated" value={<span className={run.defectsCount ? "text-defect" : undefined}>{run.defectsCount ?? "-"}</span>} />
        <Row label="LLM calls" value={run.llmCalls === undefined ? "-" : `${run.llmCalls} / ${budget}`} />
        {run.partialReason && <Row label="Stopped because" value={<span className="text-flaky">{run.partialReason}</span>} />}
      </div>
    </Card>
  );
}
```

- [ ] **Step 7: Write `ui/components/run/RunHeader.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Button, StatusPill } from "@/components/ui";
import { fileUrl, reportUrl, type ArtifactManifest, type RunRecord } from "@/lib/api";
import { formatDuration, relativeTime } from "@/lib/format";

/** Elapsed time for a run still in flight; the stored duration once it has finished. */
function useElapsed(run: RunRecord): string {
  const [now, setNow] = useState(() => Date.now());
  const live = run.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return live ? formatDuration(now - Date.parse(run.startedAt)) : formatDuration(run.durationMs);
}

export function RunHeader({ run, manifest }: { run: RunRecord; manifest: ArtifactManifest }) {
  const elapsed = useElapsed(run);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-8 pb-4 pt-6">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate font-mono text-lg font-semibold text-fg">{run.url}</h1>
          <StatusPill status={run.status} />
        </div>
        <p className="text-[13px] text-muted">
          started {relativeTime(run.startedAt)} · {elapsed}
          {run.intent && <> · {run.intent}</>}
        </p>
      </div>
      <div className="flex gap-2">
        <a href={reportUrl(run.id)} target="_blank" rel="noreferrer" aria-disabled={!manifest.hasReport}>
          <Button variant="outline" size="sm" disabled={!manifest.hasReport}>Open report</Button>
        </a>
        {manifest.traces.length > 0 && (
          <a href={fileUrl(run.id, `traces/${manifest.traces[0]}`)} download>
            <Button variant="outline" size="sm">Download trace</Button>
          </a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Write `ui/app/(app)/runs/[id]/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Spinner, Tabs } from "@/components/ui";
import { RunHeader } from "@/components/run/RunHeader";
import { Pipeline } from "@/components/run/Pipeline";
import { Feed } from "@/components/run/Feed";
import { Decisions } from "@/components/run/Decisions";
import { Results } from "@/components/run/Results";
import { PlanPanel } from "@/components/run/PlanPanel";
import { ReportFrame } from "@/components/run/ReportFrame";
import { BrowserCard } from "@/components/run/BrowserCard";
import { SummaryCard } from "@/components/run/SummaryCard";
import { useRunEvents } from "@/lib/events";
import { decisionRows, isDone, testRows } from "@/lib/derive";
import { getRun, type ArtifactManifest, type RunRecord } from "@/lib/api";

type TabId = "feed" | "decisions" | "results" | "plan" | "report";

export default function RunPage() {
  const runId = String(useParams().id);
  const [record, setRecord] = useState<{ run: RunRecord; manifest: ArtifactManifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("feed");

  // The stream is identical for a live run and a stored one: /events/:id replays
  // events.jsonl before it subscribes, so this page needs no replay-specific branch.
  const events = useRunEvents(runId);
  const done = isDone(events);

  useEffect(() => {
    getRun(runId).then(setRecord).catch((err) => setError((err as Error).message));
  }, [runId]);

  // Re-read the record once the run finishes so the summary and the manifest reflect it.
  useEffect(() => {
    if (!done) return;
    getRun(runId).then(setRecord).catch(() => {});
  }, [done, runId]);

  if (error) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: runId }]} />
        <p role="alert" className="m-8 rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>
      </>
    );
  }
  if (!record) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: runId }]} />
        <div className="flex justify-center p-16"><Spinner size={22} /></div>
      </>
    );
  }

  const tabs = [
    { id: "feed" as const, label: "Feed" },
    { id: "decisions" as const, label: "Decisions", badge: decisionRows(events).length },
    { id: "results" as const, label: "Results", badge: testRows(events).length },
    { id: "plan" as const, label: "Plan" },
    { id: "report" as const, label: "Report" },
  ];

  return (
    <>
      <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: record.run.id }]} />
      <RunHeader run={record.run} manifest={record.manifest} />

      <div className="border-y border-line bg-app px-8 py-3">
        <Pipeline events={events} />
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <Card title="Agent activity" actions={<Tabs tabs={tabs} active={tab} onChange={setTab} />} padded={false}>
          {/* One height for every panel, sized against the viewport, so no panel is a stubby fixed box. */}
          <div className="h-[min(60vh,34rem)] p-3">
            {tab === "feed" && <Feed events={events} />}
            {tab === "decisions" && <Decisions events={events} />}
            {tab === "results" && <Results events={events} />}
            {tab === "plan" && <PlanPanel runId={runId} available={record.manifest.files.includes("plan.md")} />}
            {tab === "report" && <ReportFrame runId={runId} available={record.manifest.hasReport} />}
          </div>
        </Card>

        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <BrowserCard events={events} runId={runId} />
          <SummaryCard run={record.run} />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit -p ui/tsconfig.json`
Expected: clean.

Run: `npm run lint -w ui`
Expected: clean. The one `no-img-element` rule is disabled inline with a reason, because the screenshot comes from an authenticated API route rather than a static asset.

- [ ] **Step 10: Commit**

```bash
git add ui/components/run "ui/app/(app)/runs/[id]"
git commit -m "qa-pilot ui: run detail screen serving live and replayed runs from one component set"
```

---

## Task 20: Documentation and end-to-end verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Update `.env.example`**

```
ANTHROPIC_API_KEY=sk-ant-...
QA_PILOT_MODEL=claude-opus-5
QA_PILOT_HEADLESS=0
QA_PILOT_API_PORT=4000
# MongoDB Atlas connection string. Never commit the real value; .env is gitignored.
# MONGO_URI is also accepted as a fallback, for .env files that already use that name.
QA_PILOT_MONGO_URL=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
QA_PILOT_MONGO_DB=qa_pilot
QA_PILOT_UI_ORIGIN=http://localhost:3000
```

- [ ] **Step 2: Update the README**

Add the three variables to the configuration table:

| Variable | Default | Meaning |
|---|---|---|
| `QA_PILOT_MONGO_URL` | required | MongoDB Atlas connection string |
| `QA_PILOT_MONGO_DB` | `qa_pilot` | Database name |
| `QA_PILOT_UI_ORIGIN` | `http://localhost:3000` | Origin allowed to send credentialed requests |

Replace the "Quick start" step that says to edit `.env` with a version naming both secrets, and add an **Accounts and run history** section after it:

```markdown
## Accounts and run history

The API requires a session. Open the UI, create an account with an email and a password,
and every run you start is recorded against it.

The dashboard lists your runs with coverage, pass and fail counts, heals, and defects.
Opening a finished run replays it: the pipeline strip, the decision timeline, the agent
feed, the results, and the report are rebuilt from the stored event log, so a stored run
looks exactly like a live one.

Runs started from the CLI are attributed to a reserved `local@qa-pilot` account, which has
no usable password and cannot be logged into. They appear in that account's history.

MongoDB holds accounts, sessions, and run metadata. Every artifact stays on disk in
`output/<run_id>/`. Credentials for the application under test are used for the run and
are never stored.

Check the database is reachable before a demo:

```bash
curl -s localhost:4000/health
```
```

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Add a section after "Events":

```markdown
## Accounts and storage

The orchestrator API owns authentication and the store, because the CLI also creates runs
and a single writer over one schema is only possible if the store lives there. The UI is a
thin client that sends the session cookie with every request, including on `EventSource`
and on screenshot loads.

MongoDB holds three collections: `users`, `sessions` keyed by the SHA-256 of the cookie
token with a TTL index on expiry, and `runs` keyed by the existing run id. Artifacts stay
on disk, which is what makes replay free: `EventBus` already rehydrates from
`events.jsonl`, and `GET /events/:id` already replays the whole history before streaming,
so a stored run drives the same UI components as a live one.

A run's process can die. Rather than rewriting rows at boot, which on a shared cluster
would clobber another operator's in-flight runs, each finished node stamps `heartbeatAt`
and a `running` record with a heartbeat older than five minutes is reported as
`interrupted` on read.

Passwords are scrypt with a per-user salt and the parameters stored alongside the hash.
Ownership failures on run-scoped routes return 404 rather than 403, so the API never
confirms that another account's run id exists.
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS across all four workspaces.

Run: `npm run typecheck`
Expected: clean.

Run: `npx tsc --noEmit -p ui/tsconfig.json && npm run lint -w ui`
Expected: clean.

Run: `QA_PILOT_MONGO_URL="$(grep -m1 '^QA_PILOT_MONGO_URL=' .env | cut -d= -f2-)" npm test -w orchestrator -- store`
Expected: PASS with both the memory and Mongo passes.

- [ ] **Step 5: End-to-end walkthrough**

With `npm run shop`, `npm run api`, and `npm run ui` running:

1. `curl -s localhost:4000/health` reports `mongo: "up"`.
2. Open `http://localhost:3000`; you are redirected to `/login`.
3. Create an account. You land on Overview with an empty state.
4. Start a run against `http://localhost:3005` with the demo credentials and the intent "focus on auth and checkout". You are taken to `/runs/<id>` and the pipeline strip lights up.
5. Go back to Overview mid-run. The run appears with status `running`.
6. Let it finish. Overview shows coverage, pass and fail counts, heals, and defects.
7. Reload `/runs/<id>`. The whole run rebuilds from the stored events: pipeline, feed, decisions, results, and the report in its tab.
8. `npm run qa-pilot -- run http://localhost:3005 --username demo@shop.test --password demo1234` still works with no login and records under `local@qa-pilot`.
9. Log out. `/` redirects to `/login`, and `curl -s -o /dev/null -w '%{http_code}' localhost:4000/runs` returns 401.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md ARCHITECTURE.md
git commit -m "qa-pilot: document accounts, run history, and the Mongo configuration"
```
