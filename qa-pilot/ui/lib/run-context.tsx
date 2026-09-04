"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getRun, type ArtifactManifest, type RunRecord } from "./api";
import { useRunEvents, type RunEvent } from "./events";
import { usePlan } from "./hooks";
import { caseRows, isAwaitingReview, isDoneEvents, type CaseRow, type Flow } from "./cases";

export type RunContextValue = {
  runId: string;
  run: RunRecord | null;
  manifest: ArtifactManifest | null;
  error: string | null;
  events: RunEvent[];
  plan: Flow[] | null;
  rows: CaseRow[];
  awaitingReview: boolean;
  /** Re-reads the run record and manifest, for example after a rerun or once the run finishes. */
  refresh: () => void;
  /**
   * Appends an event that did not arrive over the stream. The stream closes when a run is
   * done, so a later single-test rerun reports its start and result through here; the
   * derived rows treat it exactly like a streamed event.
   */
  pushEvent: (e: RunEvent) => void;
  selectedTest: string | null;
  selectTest: (id: string | null) => void;
};

const Ctx = createContext<RunContextValue | null>(null);

/**
 * One subscription per run, shared by every screen under /runs/[id]. The SSE stream, the
 * plan file and the derived test rows live here so that switching between Test Runs, Test
 * Cases and Coverage neither reconnects nor recomputes, and so the detail drawer can be
 * opened from any of them through the `test` query parameter.
 */
export function RunProvider({ runId, children }: { runId: string; children: React.ReactNode }) {
  const [record, setRecord] = useState<{ run: RunRecord; manifest: ArtifactManifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<RunEvent[]>([]);
  const streamed = useRunEvents(runId);
  const events = useMemo(() => (local.length ? [...streamed, ...local] : streamed), [streamed, local]);
  const plan = usePlan(runId, events);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const refresh = useCallback(() => {
    getRun(runId).then((r) => { setRecord(r); setError(null); }).catch((err) => setError((err as Error).message));
  }, [runId]);

  useEffect(() => { refresh(); }, [refresh]);

  // The record carries the summary and the manifest, both of which change when the run
  // finishes and when it parks at (or leaves) the review gate.
  const done = isDoneEvents(events);
  const awaitingReview = isAwaitingReview(events);
  useEffect(() => { refresh(); }, [done, awaitingReview, refresh]);

  const rows = useMemo(() => caseRows(events, plan ?? []), [events, plan]);
  const pushEvent = useCallback((e: RunEvent) => setLocal((prev) => [...prev, e]), []);

  const selectedTest = params.get("test");
  const selectTest = useCallback((id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("test", id); else next.delete("test");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const value = useMemo<RunContextValue>(() => ({
    runId, run: record?.run ?? null, manifest: record?.manifest ?? null, error, events, plan, rows, awaitingReview, refresh, pushEvent, selectedTest, selectTest,
  }), [runId, record, error, events, plan, rows, awaitingReview, refresh, pushEvent, selectedTest, selectTest]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRun(): RunContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRun must be used under a RunProvider");
  return v;
}
