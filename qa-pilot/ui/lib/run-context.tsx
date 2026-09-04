"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getRun, type ArtifactManifest, type RunRecord } from "./api";
import { useRunEvents, type RunEvent } from "./events";
import { usePlan } from "./hooks";
import { caseRows, isAwaitingReview, isDoneEvents, type CaseRow, type Flow } from "./cases";
import { stages, type Stage } from "./stages";

export type RunContextValue = {
  runId: string;
  run: RunRecord | null;
  manifest: ArtifactManifest | null;
  error: string | null;
  events: RunEvent[];
  plan: Flow[] | null;
  rows: CaseRow[];
  awaitingReview: boolean;
  /** The four workspace stages with their current status, shared by the rail and every screen. */
  stages: Stage[];
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
 * One subscription per run, mounted around the whole app shell.
 *
 * It sits above the sidebar rather than inside the run routes because the rail badges each
 * stage from the same derivation the screens use, and two subscriptions would eventually
 * disagree about where the run had got to. Keeping it here also means moving between
 * Sources, Coverage, Test Cases and Test Runs neither reconnects the stream nor recomputes
 * the plan, and the detail drawer can be opened from any of them via the `test` parameter.
 *
 * `runId` is null on the screens that are not a run (the overview, the start form); the
 * context is then null too, so `useRun` still fails loudly anywhere it is used by mistake.
 */
export function RunProvider({ runId, children }: { runId: string | null; children: React.ReactNode }) {
  const [record, setRecord] = useState<{ run: RunRecord; manifest: ArtifactManifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<RunEvent[]>([]);
  const [tracked, setTracked] = useState(runId);
  if (tracked !== runId) {
    setTracked(runId);
    setRecord(null);
    setError(null);
    setLocal([]);
  }
  const streamed = useRunEvents(runId);
  const events = useMemo(() => (local.length ? [...streamed, ...local] : streamed), [streamed, local]);
  const plan = usePlan(runId, events);
  const stageList = useMemo(() => stages(events, record?.run.status), [events, record]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const refresh = useCallback(() => {
    if (!runId) return;
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
    runId: runId ?? "", run: record?.run ?? null, manifest: record?.manifest ?? null, error, events, plan, rows, awaitingReview, stages: stageList, refresh, pushEvent, selectedTest, selectTest,
  }), [runId, record, error, events, plan, rows, awaitingReview, stageList, refresh, pushEvent, selectedTest, selectTest]);

  return <Ctx.Provider value={runId ? value : null}>{children}</Ctx.Provider>;
}

export function useRun(): RunContextValue {
  const v = useRunOrNull();
  if (!v) throw new Error("useRun must be used under a RunProvider");
  return v;
}

/**
 * The run in scope, or null when there is none.
 *
 * The provider now wraps the whole app shell so the sidebar can badge each stage from the
 * same subscription the screens read, and the shell also renders on pages that are not a
 * run at all (the overview, the start form). Those get null rather than a thrown error.
 */
export function useRunOrNull(): RunContextValue | null {
  return useContext(Ctx);
}
