import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_CAP, EmailTakenError, RunIdTakenError, normaliseEmail, withDerivedStatus, type ChatRecord, type ChatSummary, type RunRecord, type Store, type User } from "./types.js";

/**
 * The `Store` over plain Maps. Used by every test that is not specifically testing Mongo,
 * mirroring how the LLM client is already faked in this codebase, so `npm test` needs no
 * database. Expiry and derived status are implemented here exactly as Mongo implements
 * them, and `test/store.test.ts` runs the same contract against both.
 */
/** Drops the transcript, draft and pending rerun, mirroring what the Mongo projection leaves out. */
function summary(rec: ChatRecord): ChatSummary {
  const { messages: _messages, draft, pending: _pending, ...rest } = rec;
  const url = rec.kind === "copilot" ? rec.scope?.url : draft.url;
  return url ? { ...rest, url } : rest;
}

/** A document written before `kind` existed is an intake chat. */
function withKind(rec: ChatRecord): ChatRecord {
  return { ...rec, kind: rec.kind ?? "intake" };
}

export function memoryStore(): Store {
  const users = new Map<string, User & { passwordHash: string }>();
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const runs = new Map<string, RunRecord>();
  const chats = new Map<string, ChatRecord>();

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
      if (runs.has(rec.id)) throw new RunIdTakenError(rec.id);
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

    async insertChat(rec) {
      chats.set(rec.id, { ...rec, messages: [...rec.messages], draft: { ...rec.draft } });
    },
    async getChat(id) {
      const rec = chats.get(id);
      return rec ? withKind({ ...rec, messages: [...rec.messages], draft: { ...rec.draft } }) : null;
    },
    async listChats(userId, opts = {}) {
      const limit = opts.limit ?? 50;
      return [...chats.values()]
        .map(withKind)
        .filter((c) => c.userId === userId && (!opts.kind || c.kind === opts.kind))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map(summary);
    },
    async appendChatTurn(id, messages, patch) {
      const cur = chats.get(id);
      if (!cur) return;
      const next: ChatRecord = {
        ...cur,
        messages: cur.messages.concat(messages).slice(-CHAT_MESSAGE_CAP),
        draft: patch.draft ? { ...patch.draft } : cur.draft,
        title: patch.title ?? cur.title,
        runId: patch.runId ?? cur.runId,
        scope: patch.scope ? { ...patch.scope } : cur.scope,
        updatedAt: new Date().toISOString(),
      };
      if (patch.pending === null) delete next.pending;
      else if (patch.pending) next.pending = { ...patch.pending, testIds: [...patch.pending.testIds] };
      chats.set(id, next);
    },
    async deleteChat(id) {
      chats.delete(id);
    },

    async close() { /* nothing to release */ },
  };
}
