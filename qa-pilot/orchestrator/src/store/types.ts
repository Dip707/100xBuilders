/** How long a `running` run may go without a heartbeat before it reads as interrupted. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;

/** `awaiting_review` is a run paused at the plan-review gate; it has no heartbeat and never reads as interrupted. */
export type RunStatus = "running" | "awaiting_review" | "done" | "partial" | "failed" | "interrupted";

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
