import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_CAP, EmailTakenError, RunIdTakenError, normaliseEmail, withDerivedStatus, type ChatRecord, type ChatSummary, type RunRecord, type Store, type User } from "./types.js";

/**
 * The `Store` over plain Maps. Used by every test that is not specifically testing Mongo,
 * mirroring how the LLM client is already faked in this codebase, so `npm test` needs no
 * database. Expiry and derived status are implemented here exactly as Mongo implements
 * them, and `test/store.test.ts` runs the same contract against both.
 */
/** Drops the transcript and draft, mirroring what the Mongo projection leaves out. */
function summary(rec: ChatRecord): ChatSummary {
  const { messages: _messages, draft, ...rest } = rec;
  return draft.url ? { ...rest, url: draft.url } : rest;
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
      return rec ? { ...rec, messages: [...rec.messages], draft: { ...rec.draft } } : null;
    },
    async listChats(userId, limit = 50) {
      return [...chats.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map(summary);
    },
    async appendChatTurn(id, messages, patch) {
      const cur = chats.get(id);
      if (!cur) return;
      chats.set(id, {
        ...cur,
        messages: cur.messages.concat(messages).slice(-CHAT_MESSAGE_CAP),
        draft: patch.draft ? { ...patch.draft } : cur.draft,
        title: patch.title ?? cur.title,
        runId: patch.runId ?? cur.runId,
        updatedAt: new Date().toISOString(),
      });
    },
    async deleteChat(id) {
      chats.delete(id);
    },

    async close() { /* nothing to release */ },
  };
}
