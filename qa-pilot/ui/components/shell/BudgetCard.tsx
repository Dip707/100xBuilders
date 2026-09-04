"use client";
import { useEffect, useState } from "react";
import { Meter } from "@/components/ui";
import { listRuns } from "@/lib/api";

/** The API's default per-run cap, which is what a single run is measured against. */
const PER_RUN_CAP = 200;

export function BudgetCard() {
  const [totals, setTotals] = useState<{ runs: number; calls: number } | null>(null);

  useEffect(() => {
    // Deliberately the same /runs call the Overview page makes. The list is small and
    // per-account, so a second fetch is cheaper than threading shared state through the
    // shell for one card.
    listRuns()
      .then((runs) => setTotals({ runs: runs.length, calls: runs.reduce((n, r) => n + (r.llmCalls ?? 0), 0) }))
      .catch(() => setTotals(null));
  }, []);

  if (!totals) return null;
  const latestRunShare = Math.min(totals.calls, PER_RUN_CAP);

  return (
    <div className="space-y-2 rounded-card bg-accent-tint p-3.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-accent">
        <span aria-hidden="true">✦</span> LLM budget
      </p>
      <p className="text-[12px] leading-relaxed text-accent/80">
        {totals.calls} calls across {totals.runs} {totals.runs === 1 ? "run" : "runs"}.
      </p>
      <Meter value={latestRunShare} max={PER_RUN_CAP} />
      <p className="text-[11px] text-accent/70">{PER_RUN_CAP} calls is the default cap per run.</p>
    </div>
  );
}
