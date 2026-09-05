/** How long a `running` run may go without a heartbeat before it reads as interrupted. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;

/** `awaiting_review` is a run paused at the plan-review gate; it has no heartbeat and never reads as interrupted. */
export type RunStatus = "running" | "awaiting_review" | "done" | "partial" | "failed" | "interrupted";

export type User = { id: string; email: string; createdAt: string };

/** Newest N messages kept per chat, so a long conversation cannot grow a document without bound. */
export const CHAT_MESSAGE_CAP = 200;

export type ChatKind = "intake" | "copilot";

/** What a copilot chat acts on: a target URL, optionally narrowed to one run. */
export type ChatScope = { url?: string; runId?: string };

/** A rerun the copilot decided on: the tests it will run, and the ones it cannot and why. */
export type RerunPlanData = {
  kind: "rerun_plan";
  runId: string;
  testIds: string[];
  blocked: { id: string; reason: string }[];
};

/** The outcome of an executed rerun, stored on the message so reopening the chat shows it. */
export type RerunResultData = {
  kind: "rerun_result";
  runId: string;
  results: {
    id: string;
    title: string;
    status: string;
    error?: string;
    durationMs?: number;
    /** The pipeline run's classification of this test, when it had one. A rerun never classifies. */
    verdict?: { class: string; confidence: number };
    /** The defect record the pipeline escalated for this test, when it did. */
    defectId?: string;
  }[];
};

export type ChatMessageData = RerunPlanData | RerunResultData;

export type ChatMessage = { role: "user" | "assistant"; text: string; at: string; data?: ChatMessageData };

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
  /** Documents written before this field existed have none and are read as "intake". */
  kind: ChatKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Accumulated run configuration. Intake only; a copilot chat stores {}. */
  draft: RunDraft;
  /** Copilot only. */
  scope?: ChatScope;
  /** Copilot only: a rerun decided but not yet executed. */
  pending?: { runId: string; testIds: string[] };
  /** Set when a run is started from an intake chat, so history links to what it produced. */
  runId?: string;
};

/** A chat without its transcript, for the chats dropdown. */
export type ChatSummary = Omit<ChatRecord, "messages" | "draft" | "pending"> & { url?: string };

export type ChatTurnPatch = {
  draft?: RunDraft;
  title?: string;
  runId?: string;
  scope?: ChatScope;
  /** `null` clears a pending rerun once it has executed. */
  pending?: { runId: string; testIds: string[] } | null;
};

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

export type TrackerProvider = "linear" | "jira";

/** Where a tracker connection files issues: a Linear team id or a Jira project key, with the name shown to the person. */
export type TrackerDestination = { id: string; label: string };

/**
 * One tracker connection per user. The OAuth token lives with Composio; this record holds
 * only Composio's connected account id, so nothing here is a credential.
 */
export type IntegrationRecord = {
  userId: string;
  provider: TrackerProvider;
  connectedAccountId: string;
  /** `pending` from the moment the OAuth link is created until the callback sees it active. */
  status: "pending" | "active";
  destination?: TrackerDestination;
  connectedAt: string;
};

/** An issue filed in a tracker for one test of one run. */
export type TicketRecord = {
  id: string;
  userId: string;
  runId: string;
  testId: string;
  provider: TrackerProvider;
  key: string;
  url: string;
  createdAt: string;
};

/** Thrown by `insertTicket` when this run and test already have a ticket for this user. */
export class TicketTakenError extends Error {
  constructor(runId: string, testId: string) {
    super(`a ticket already exists for ${testId} in run ${runId}`);
    this.name = "TicketTakenError";
  }
}

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
  listChats(userId: string, opts?: { limit?: number; kind?: ChatKind }): Promise<ChatSummary[]>;
  /**
   * Appends the turn's messages and merges the draft, title and runId in a single write, so
   * a turn cannot half-land. Unknown ids are ignored rather than upserted: an id that is not
   * already there failed the ownership check, and inventing a document would hide that.
   */
  appendChatTurn(id: string, messages: ChatMessage[], patch: ChatTurnPatch): Promise<void>;
  deleteChat(id: string): Promise<void>;

  saveIntegration(rec: IntegrationRecord): Promise<void>;
  getIntegration(userId: string): Promise<IntegrationRecord | null>;
  deleteIntegration(userId: string): Promise<void>;

  insertTicket(rec: TicketRecord): Promise<void>;
  findTicket(userId: string, runId: string, testId: string): Promise<TicketRecord | null>;
  listTickets(userId: string, runId: string): Promise<TicketRecord[]>;

  close(): Promise<void>;
}
