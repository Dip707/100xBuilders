/** How long a `running` run may go without a heartbeat before it reads as interrupted. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;

/** `awaiting_review` is a run paused at the plan-review gate; it has no heartbeat and never reads as interrupted. */
export type RunStatus = "running" | "awaiting_review" | "done" | "partial" | "failed" | "interrupted";

export type User = { id: string; email: string; createdAt: string };

/** Newest N messages kept per chat, so a long conversation cannot grow a document without bound. */
export const CHAT_MESSAGE_CAP = 200;

export type ChatMessage = { role: "user" | "assistant"; text: string; at: string };

/**
 * The run configuration a chat has assembled so far - the same fields the Start-a-run form
 * holds, minus the credentials. There is deliberately no password here: the target app's
 * username and password live in the page's own state for the length of the visit and are
 * sent only with the `/run` POST, so a stored transcript can never carry them.
 */
export type RunDraft = {
  url?: string;
  intent?: string;
  prdText?: string;
  prdName?: string;
  requiresSignIn?: boolean;
  maxFlows?: number;
  budget?: { maxLlmCalls?: number; maxMinutes?: number };
  reviewPlan?: boolean;
};

export type ChatRecord = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Accumulated run configuration. Reopening a chat restores the form from this. */
  draft: RunDraft;
  /** Set when a run is started from this chat, so history links to what it produced. */
  runId?: string;
};

/** A chat without its transcript, for the chats dropdown. */
export type ChatSummary = Omit<ChatRecord, "messages" | "draft"> & { url?: string };

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

/** Thrown by `insertRun` so a reused run id reads as a taken id, not a driver stack trace. */
export class RunIdTakenError extends Error {
  constructor(runId: string) {
    super(`a run with the id "${runId}" already exists; pick another --run-id or omit it to get a fresh one`);
    this.name = "RunIdTakenError";
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

  insertChat(rec: ChatRecord): Promise<void>;
  getChat(id: string): Promise<ChatRecord | null>;
  listChats(userId: string, limit?: number): Promise<ChatSummary[]>;
  /**
   * Appends the turn's messages and merges the draft, title and runId in a single write, so
   * a turn cannot half-land. Unknown ids are ignored rather than upserted: an id that is not
   * already there failed the ownership check, and inventing a document would hide that.
   */
  appendChatTurn(id: string, messages: ChatMessage[], patch: { draft?: RunDraft; title?: string; runId?: string }): Promise<void>;
  deleteChat(id: string): Promise<void>;

  close(): Promise<void>;
}
