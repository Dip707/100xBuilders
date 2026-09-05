import { MongoClient, type Collection, type Db, type Filter } from "mongodb";
import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_CAP, EmailTakenError, RunIdTakenError, TicketTakenError, normaliseEmail, withDerivedStatus, type ChatRecord, type ChatSummary, type IntegrationRecord, type RunRecord, type Store, type TicketRecord, type User } from "./types.js";

type UserDoc = { _id: string; email: string; passwordHash: string; createdAt: string };
type SessionDoc = { _id: string; userId: string; createdAt: string; expiresAt: Date };
type RunDoc = Omit<RunRecord, "id"> & { _id: string };
type ChatDoc = Omit<ChatRecord, "id" | "kind"> & { _id: string; kind?: ChatRecord["kind"] };
/** Keyed by user: one tracker connection each, so a save is a replace. */
type IntegrationDoc = Omit<IntegrationRecord, "userId"> & { _id: string };
type TicketDoc = Omit<TicketRecord, "id"> & { _id: string };

const DUPLICATE_KEY = 11000;
/** Case-insensitive comparison for the unique email index and for lookups. */
const CI = { locale: "en", strength: 2 } as const;

/**
 * How long one connect attempt waits for the cluster to answer. The previous 8s was chosen
 * to fail fast on a wrong URL or a stale Atlas IP allowlist, but it was below the cluster's
 * real cold-connect latency: measured against the project's M0 shared-tier cluster, cold
 * connects ranged from 2.2s to 25s and one attempt in six exceeded 8s outright. A boot that
 * loses that race takes the whole API down, because the store is built before serve() runs.
 * Misconfiguration still fails fast - it is rejected by isTransientConnectError, not by the
 * clock - so the wider budget costs nothing on a genuinely bad URL or credential.
 */
export const SERVER_SELECTION_TIMEOUT_MS = Number(process.env.QA_PILOT_MONGO_TIMEOUT_MS ?? 30_000);
export const CONNECT_ATTEMPTS = Number(process.env.QA_PILOT_MONGO_ATTEMPTS ?? 3);
const RETRY_DELAY_MS = 1000;

/** Auth is rejected during the handshake, so Atlas surfaces a wrong password as a selection
 *  failure whose nested per-server error is the auth rejection rather than as a bare
 *  MongoServerError. Both shapes have to be read to keep a bad credential from being retried. */
function mentionsAuthFailure(err: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 4 || v == null || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    const o = v as { message?: unknown; codeName?: unknown; servers?: unknown; error?: unknown; reason?: unknown; cause?: unknown };
    if (typeof o.message === "string" && /auth(?:entication)? fail|bad auth|not authorized/i.test(o.message)) return true;
    if (o.codeName === "AuthenticationFailed" || o.codeName === "Unauthorized") return true;
    const servers = o.servers instanceof Map ? [...o.servers.values()] : [];
    return [...servers, o.error, o.reason, o.cause].some((child) => walk(child, depth + 1));
  };
  return walk(err, 0);
}

/**
 * A transient failure is one where the cluster simply did not answer in time or the
 * connection was reset mid-handshake - retrying those is what keeps a slow shared-tier
 * cluster from killing boot. A malformed URL, a bad credential or a bad argument is
 * permanent: retrying only delays the same failure by the whole budget, so it fails fast.
 */
export function isTransientConnectError(err: unknown): boolean {
  if (mentionsAuthFailure(err)) return false;
  const name = (err as { name?: string } | null)?.name;
  return name === "MongoServerSelectionError" || name === "MongoNetworkError" || name === "MongoNetworkTimeoutError";
}

/** Bounded retry around a single connect, so one slow answer does not take the API down. */
export async function connectWithRetry(
  connect: () => Promise<MongoClient>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<MongoClient> {
  const attempts = Math.max(1, opts.attempts ?? CONNECT_ATTEMPTS);
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (err) {
      if (attempt >= attempts || !isTransientConnectError(err)) throw err;
      console.warn(
        `mongo: connect attempt ${attempt}/${attempts} failed (${(err as Error).message}); retrying in ${delayMs}ms`,
      );
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * One client per url+db, memoised so the driver's connection pool is reused across
 * requests instead of being rebuilt per call.
 */
const clients = new Map<string, Promise<MongoClient>>();

function client(url: string): Promise<MongoClient> {
  let existing = clients.get(url);
  if (!existing) {
    existing = connectWithRetry(() =>
      // ignoreUndefined keeps an optional field that a record simply does not carry - a run
      // that stopped before the coverage gate has no coverageScore - out of the document
      // rather than storing it as BSON null. RunRecord's optional fields are `number |
      // undefined`, never null, and a null read back crashes any consumer that guards with
      // `=== undefined`.
      new MongoClient(url, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, ignoreUndefined: true }).connect(),
    );
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
  await db.collection<ChatDoc>("chats").createIndex({ userId: 1, updatedAt: -1 }, { name: "chats_by_user_recent" });
  // The index is what makes a double-filed ticket impossible, not the pre-check in the route.
  await db.collection<TicketDoc>("tickets").createIndex({ userId: 1, runId: 1, testId: 1 }, { unique: true, name: "ticket_per_test" });
}

/**
 * Documents written before `ignoreUndefined` was set still hold nulls where a field was
 * absent, and rewriting them in place would touch a teammate's rows on the shared cluster.
 * Dropping nulls on read costs nothing and makes every record satisfy RunRecord, whenever it
 * was stored: no field of a run is meaningfully null.
 */
function withoutNulls(doc: Omit<RunDoc, "_id">): Omit<RunDoc, "_id"> {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== null)) as Omit<RunDoc, "_id">;
}

function toRecord(doc: RunDoc): RunRecord {
  const { _id, ...rest } = doc;
  return withDerivedStatus({ id: _id, ...withoutNulls(rest) });
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
  const chats: Collection<ChatDoc> = db.collection("chats");
  const integrations: Collection<IntegrationDoc> = db.collection("integrations");
  const tickets: Collection<TicketDoc> = db.collection("tickets");

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
      try {
        await runs.insertOne({ _id: id, ...rest });
      } catch (err) {
        if ((err as { code?: number }).code === DUPLICATE_KEY) throw new RunIdTakenError(id);
        throw err;
      }
    },
    async updateRun(id, patch) {
      const { id: _ignored, ...rest } = patch as Partial<RunRecord> & { id?: string };
      // Undefined values are dropped here rather than left to ignoreUndefined, so a patch of
      // nothing but undefined is a no-op instead of an empty $set, which Mongo rejects.
      const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
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

    async insertChat(rec) {
      const { id, ...rest } = rec;
      await chats.insertOne({ _id: id, ...rest });
    },
    async getChat(id) {
      const doc = await chats.findOne({ _id: id });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return { id: _id, ...rest, kind: rest.kind ?? "intake" };
    },
    async listChats(userId, opts = {}) {
      // A document written before `kind` existed has none and is an intake chat.
      const kind: Filter<ChatDoc> = opts.kind === "intake"
        ? { $or: [{ kind: "intake" }, { kind: { $exists: false } }] }
        : opts.kind ? { kind: opts.kind } : {};
      // draft and scope are projected in only for their url, which the dropdown shows under
      // the title; the transcript never leaves the database for a list request.
      const docs = await chats
        .find({ userId, ...kind }, { projection: { messages: 0, pending: 0 } })
        .sort({ updatedAt: -1 })
        .limit(opts.limit ?? 50)
        .toArray();
      return docs.map(({ _id, draft, ...rest }) => {
        const s: ChatSummary = { id: _id, ...(rest as Omit<ChatSummary, "id">), kind: rest.kind ?? "intake" };
        const url = s.kind === "copilot" ? rest.scope?.url : draft?.url;
        if (url) s.url = url;
        return s;
      });
    },
    async appendChatTurn(id, messages, patch) {
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (patch.draft) set.draft = patch.draft;
      if (patch.title) set.title = patch.title;
      if (patch.runId) set.runId = patch.runId;
      if (patch.scope) set.scope = patch.scope;
      if (patch.pending) set.pending = patch.pending;
      // $each with $slice: -CAP keeps the newest CAP messages in the same write that appends,
      // so the cap is enforced by the database rather than by a read-modify-write race.
      await chats.updateOne({ _id: id }, {
        $set: set,
        ...(patch.pending === null ? { $unset: { pending: "" } } : {}),
        ...(messages.length > 0 ? { $push: { messages: { $each: messages, $slice: -CHAT_MESSAGE_CAP } } } : {}),
      });
    },
    async deleteChat(id) {
      await chats.deleteOne({ _id: id });
    },

    async saveIntegration(rec) {
      const { userId, ...rest } = rec;
      await integrations.replaceOne({ _id: userId }, rest, { upsert: true });
    },
    async getIntegration(userId) {
      const doc = await integrations.findOne({ _id: userId });
      if (!doc) return null;
      const { _id, destination, ...rest } = doc;
      // A record saved without a destination must read back without one, not with a null.
      return { userId: _id, ...rest, ...(destination ? { destination } : {}) };
    },
    async deleteIntegration(userId) {
      await integrations.deleteOne({ _id: userId });
    },

    async insertTicket(rec) {
      const { id, ...rest } = rec;
      try {
        await tickets.insertOne({ _id: id, ...rest });
      } catch (err) {
        if ((err as { code?: number }).code === DUPLICATE_KEY) throw new TicketTakenError(rec.runId, rec.testId);
        throw err;
      }
    },
    async findTicket(userId, runId, testId) {
      const doc = await tickets.findOne({ userId, runId, testId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return { id: _id, ...rest };
    },
    async listTickets(userId, runId) {
      const docs = await tickets.find({ userId, runId }).sort({ createdAt: 1 }).toArray();
      return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
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
