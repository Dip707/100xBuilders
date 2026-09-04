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

export type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean };

export type NewRunInput = {
  url: string;
  intent?: string;
  prd?: string;
  credentials?: { username: string; password: string };
  maxFlows?: number;
  budget?: { maxLlmCalls: number; maxMinutes: number };
  /** Pause after the coverage gate so the plan can be reviewed before tests are generated. */
  reviewPlan?: boolean;
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

/** Fetches a run artifact as text; null when it is not there (yet). */
export async function fetchArtifact(runId: string, relPath: string): Promise<string | null> {
  const res = await fetch(fileUrl(runId, relPath), { credentials: "include" });
  return res.ok ? res.text() : null;
}

export const reportUrl = (runId: string) => `${API}/report/${encodeURIComponent(runId)}`;

export const fileUrl = (runId: string, relPath: string) =>
  `${API}/runs/${encodeURIComponent(runId)}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
