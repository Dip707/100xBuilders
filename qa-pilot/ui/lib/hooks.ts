"use client";
import { useEffect, useMemo, useState } from "react";
import { fetchArtifact } from "./api";
import type { RunEvent } from "./events";
import type { Flow } from "./cases";

/**
 * The plan the planner wrote, re-read every time a plan-changing node finishes: the plan
 * node (each iteration rewrites plan.json) and the review node (the reviewer's edits land
 * in the same file). Reading the file rather than reconstructing it from agent logs means
 * the UI shows exactly the flows the generator will see.
 */
export function usePlan(runId: string, events: RunEvent[]): Flow[] | null {
  const [plan, setPlan] = useState<Flow[] | null>(null);
  // Counting node_end events for plan/review gives a value that only changes when the
  // file on disk may have changed, so the effect is not re-run for every log line.
  const version = useMemo(() => events.filter((e) => e.type === "node_end" && (e.node === "plan" || e.node === "review")).length, [events]);
  useEffect(() => {
    let cancelled = false;
    fetchArtifact(runId, "plan.json")
      .then((text) => { if (!cancelled) setPlan(text ? (JSON.parse(text) as Flow[]) : []); })
      .catch(() => { if (!cancelled) setPlan([]); });
    return () => { cancelled = true; };
  }, [runId, version]);
  return plan;
}

export type CoverageIteration = {
  iteration: number; score: number; checks: Record<string, number>;
  gaps: Array<{ kind: string; target?: string; requirement?: string; suggest: string }>;
  untested_risk: Array<{ flow: string; reason: string; risk: string }>;
  prdRequirements: string[]; prdMatrix: Record<string, string[]>;
};

/** Every coverage evaluation so far, oldest first; the last one is what the run went with. */
export function useCoverage(runId: string, events: RunEvent[]): CoverageIteration[] | null {
  const [history, setHistory] = useState<CoverageIteration[] | null>(null);
  const version = useMemo(() => events.filter((e) => e.type === "node_end" && e.node === "evaluate_coverage").length, [events]);
  useEffect(() => {
    let cancelled = false;
    fetchArtifact(runId, "coverage.json")
      .then((text) => { if (!cancelled) setHistory(text ? (JSON.parse(text) as CoverageIteration[]) : []); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [runId, version]);
  return history;
}

/** A text artifact such as a generated spec; null until loaded, "" when absent. */
export function useArtifactText(runId: string, relPath: string | null, version = 0): string | null {
  // The loaded text is stored with the key it was loaded for, so switching to another
  // path reads as "loading" without an extra state reset inside the effect.
  const key = `${runId}:${relPath}:${version}`;
  const [loaded, setLoaded] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (!relPath) return;
    let cancelled = false;
    fetchArtifact(runId, relPath)
      .then((t) => { if (!cancelled) setLoaded({ key, text: t ?? "" }); })
      .catch(() => { if (!cancelled) setLoaded({ key, text: "" }); });
    return () => { cancelled = true; };
  }, [runId, relPath, version, key]);
  return loaded?.key === key ? loaded.text : null;
}
