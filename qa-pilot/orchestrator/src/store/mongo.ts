import { MongoClient, type Collection, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_CAP, EmailTakenError, RunIdTakenError, normaliseEmail, withDerivedStatus, type ChatRecord, type ChatSummary, type RunRecord, type Store, type User } from "./types.js";

type UserDoc = { _id: string; email: string; passwordHash: string; createdAt: string };
type SessionDoc = { _id: string; userId: string; createdAt: string; expiresAt: Date };
type RunDoc = Omit<RunRecord, "id"> & { _id: string };
type ChatDoc = Omit<ChatRecord, "id"> & { _id: string };

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
  await db.collection<ChatDoc>("chats").createIndex({ userId: 1, updatedAt: -1 }, { name: "chats_by_user_recent" });
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
  const chats: Collection<ChatDoc> = db.collection("chats");

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

    async insertChat(rec) {
      const { id, ...rest } = rec;
      await chats.insertOne({ _id: id, ...rest });
    },
    async getChat(id) {
      const doc = await chats.findOne({ _id: id });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return { id: _id, ...rest };
    },
    async listChats(userId, limit = 50) {
      // draft is projected in only for its url, which the dropdown shows under the title;
      // the transcript never leaves the database for a list request.
      const docs = await chats
        .find({ userId }, { projection: { messages: 0 } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map(({ _id, draft, ...rest }) => {
        const s: ChatSummary = { id: _id, ...(rest as Omit<ChatSummary, "id">) };
        if (draft?.url) s.url = draft.url;
        return s;
      });
    },
    async appendChatTurn(id, messages, patch) {
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (patch.draft) set.draft = patch.draft;
      if (patch.title) set.title = patch.title;
      if (patch.runId) set.runId = patch.runId;
      // $each with $slice: -CAP keeps the newest CAP messages in the same write that appends,
      // so the cap is enforced by the database rather than by a read-modify-write race.
      await chats.updateOne({ _id: id }, {
        $set: set,
        ...(messages.length > 0 ? { $push: { messages: { $each: messages, $slice: -CHAT_MESSAGE_CAP } } } : {}),
      });
    },
    async deleteChat(id) {
      await chats.deleteOne({ _id: id });
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
