"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export type RunEvent = { type: string; runId: string; at: string; node?: string; agent?: string; message?: string; data?: unknown };
export const API = process.env.NEXT_PUBLIC_QA_PILOT_API ?? "http://localhost:4000";
export const NODES = ["explore", "plan", "evaluate_coverage", "generate", "run", "classify", "heal", "report"] as const;

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [trackedRunId, setTrackedRunId] = useState<string | null>(null);
  const ref = useRef<EventSource | null>(null);
  // The API always replays the full event history on every new /events/:runId
  // connection (it does not honor Last-Event-ID). In dev, React Strict Mode
  // mounts this effect twice, opening a second EventSource that replays the
  // same history again; seenIds (one Set per runId, shared by both mounts)
  // collapses those duplicates by SSE id, which is stable across connections
  // because every connection numbers its replay from 0 in bus order.
  // Deliberately keyed by runId alone (unused inside the factory) so both
  // Strict Mode mounts of the effect below share one Set that resets exactly
  // when a new run starts.
  const seenIds = useMemo(() => new Set<string>(), [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (runId !== trackedRunId) {
    setTrackedRunId(runId);
    setEvents([]);
  }
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`${API}/events/${runId}`);
    ref.current = es;
    const push = (e: MessageEvent) => {
      // "error" is both our app-level SSE event name and EventSource's native
      // connection-error event (fired e.g. when the server closes the stream
      // after "done"); the native one has no string payload, so skip it here.
      if (typeof e.data !== "string") return;
      if (e.lastEventId) {
        if (seenIds.has(e.lastEventId)) return;
        seenIds.add(e.lastEventId);
      }
      const parsed = JSON.parse(e.data) as RunEvent;
      setEvents((prev) => [...prev, parsed]);
      if (parsed.type === "done") es.close();
    };
    for (const t of ["node_start", "node_end", "decision", "agent_log", "screenshot", "test_result", "error", "done"]) es.addEventListener(t, push as EventListener);
    return () => es.close();
    // seenIds is re-derived from runId (see useMemo above), so it changes in
    // lockstep with runId and does not need to be listed separately.
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  return events;
}

export async function startRun(body: { url: string; intent?: string; prd?: string; username?: string; password?: string }): Promise<string> {
  const payload: Record<string, unknown> = { url: body.url, intent: body.intent || undefined, prd: body.prd || undefined };
  if (body.username && body.password) payload.credentials = { username: body.username, password: body.password };
  const res = await fetch(`${API}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).runId as string;
}
