"use client";

export const API = process.env.NEXT_PUBLIC_QA_PILOT_API ?? "http://localhost:4000";

export type PublicUser = { id: string; email: string; createdAt: string };
export type RunStatus = "running" | "awaiting_review" | "done" | "partial" | "failed" | "interrupted";

export type RunRecord = {
  id: string; userId: string; url: string; intent?: string; hasPrd: boolean;
  status: RunStatus; startedAt: string; heartbeatAt?: string; finishedAt?: string;
  durationMs?: number; coverageScore?: number; planIterations?: number; flowsTotal?: number;
  testsPassed?: number; testsFailed?: number; healsAccepted?: number; defectsCount?: number;
  llmCalls?: number; partialReason?: string;
};

export type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean; hasSuite: boolean };

export type NewRunInput = {
  url: string;
  intent?: string;
  prd?: string;
  credentials?: { username: string; password: string };
  maxFlows?: number;
  budget?: { maxLlmCalls: number; maxMinutes: number };
  /** Pause after the coverage gate so the plan can be reviewed before tests are generated. */
  reviewPlan?: boolean;
  /** The chat this run was configured in, so the conversation links to what it produced. */
  chatId?: string;
};

export type ChatKind = "intake" | "copilot";

/** A rerun the copilot decided on: what will run, and what cannot and why. */
export type RerunPlanData = { kind: "rerun_plan"; runId: string; testIds: string[]; blocked: { id: string; reason: string }[] };
/** The outcome of an executed rerun, stored on the message so a reopened chat shows it. */
export type RerunResultData = {
  kind: "rerun_result";
  runId: string;
  results: { id: string; title: string; status: string; error?: string; durationMs?: number }[];
};
export type ChatMessageData = RerunPlanData | RerunResultData;

export type ChatMessage = { role: "user" | "assistant"; text: string; at: string; data?: ChatMessageData };

/** What a copilot chat acts on: a target URL, optionally narrowed to one run. */
export type ChatScope = { url?: string; runId?: string };

/** What a chat has assembled so far. Never carries the target app's credentials. */
export type ChatDraft = {
  url?: string; intent?: string; prdText?: string; prdName?: string;
  requiresSignIn?: boolean; maxFlows?: number;
  budget?: { maxLlmCalls?: number; maxMinutes?: number }; reviewPlan?: boolean;
};

export type Chat = {
  id: string; userId: string; kind: ChatKind; title: string; createdAt: string; updatedAt: string;
  messages: ChatMessage[]; draft: ChatDraft; scope?: ChatScope; pending?: { runId: string; testIds: string[] }; runId?: string;
};

/** A chat without its transcript, as the chats dropdown lists them. */
export type ChatSummary = Omit<Chat, "messages" | "draft"> & { url?: string };

export type ChatNeed = "url" | "intent" | "prd" | "credentials";

export type ChatTurn = {
  reply: string;
  patch: ChatDraft;
  needs: ChatNeed[];
  /** The draft after the patch, as the server stored it. */
  draft: ChatDraft;
  title?: string;
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

/** Hands the reviewed (possibly trimmed or edited) plan to a run parked at the review gate. */
export const submitReview = (runId: string, flows: unknown[]) =>
  apiFetch<{ ok: true; flows: number }>(`/runs/${encodeURIComponent(runId)}/review`, { method: "POST", body: JSON.stringify({ flows }) });

/** Re-executes one generated test of a finished run; resolves with its fresh result. */
export const rerunTest = (runId: string, testId: string) =>
  apiFetch<{ result: unknown }>(`/runs/${encodeURIComponent(runId)}/tests/${encodeURIComponent(testId)}/rerun`, { method: "POST" }).then((r) => r.result);

export const createChat = () => apiFetch<{ chat: Chat }>("/chats", { method: "POST" }).then((r) => r.chat);

export const listChats = () => apiFetch<{ chats: ChatSummary[] }>("/chats").then((r) => r.chats);

export const getChat = (id: string) => apiFetch<{ chat: Chat }>(`/chats/${encodeURIComponent(id)}`).then((r) => r.chat);

export const deleteChat = (id: string) => apiFetch<void>(`/chats/${encodeURIComponent(id)}`, { method: "DELETE" });

/** One conversational turn. `snapshot` is the form as it stands, which the server takes as the base. */
export const sendChatMessage = (id: string, text: string, snapshot: Record<string, unknown>) =>
  apiFetch<ChatTurn>(`/chats/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, snapshot }),
  });

export type CopilotAction = "rerun" | "answer" | "clarify";

export type CopilotTurn = {
  reply: string;
  action: CopilotAction;
  /** The run the turn resolved to and answered about. Absent when no finished run was found. */
  runId?: string;
  /** Present on a rerun: what will run once `executeCopilot` is called. */
  plan?: RerunPlanData;
  needs: ("credentials")[];
  title?: string;
};

export type CopilotExecution = { reply: string; result: RerunResultData };

export const createCopilotChat = (scope: ChatScope) =>
  apiFetch<{ chat: Chat }>("/copilot/chats", { method: "POST", body: JSON.stringify(scope) }).then((r) => r.chat);

export const listCopilotChats = () => apiFetch<{ chats: ChatSummary[] }>("/copilot/chats").then((r) => r.chats);

/** One copilot turn: the decision, not the execution. */
export const sendCopilotMessage = (id: string, text: string) =>
  apiFetch<CopilotTurn>(`/copilot/chats/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) });

/**
 * Executes the chat's pending rerun. The credentials travel only in this request and are
 * dropped by the server when it returns; they are never part of a message.
 */
export const executeCopilot = (id: string, credentials?: { username: string; password: string }) =>
  apiFetch<CopilotExecution>(`/copilot/chats/${encodeURIComponent(id)}/execute`, {
    method: "POST",
    body: JSON.stringify(credentials ? { credentials } : {}),
  });

/** Fetches a run artifact as text; null when it is not there (yet). */
export async function fetchArtifact(runId: string, relPath: string): Promise<string | null> {
  const res = await fetch(fileUrl(runId, relPath), { credentials: "include" });
  return res.ok ? res.text() : null;
}

export const reportUrl = (runId: string) => `${API}/report/${encodeURIComponent(runId)}`;

/** The run's generated tests as a standalone Playwright project, ready to run outside qa-pilot. */
export const suiteUrl = (runId: string) => `${API}/runs/${encodeURIComponent(runId)}/suite.zip`;

export const fileUrl = (runId: string, relPath: string) =>
  `${API}/runs/${encodeURIComponent(runId)}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
