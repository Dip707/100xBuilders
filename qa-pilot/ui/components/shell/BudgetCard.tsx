"use client";
import { useEffect, useState } from "react";
import { Icon, Meter } from "@/components/ui";
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
    <div className="space-y-2 rounded-box border border-line bg-surface p-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium tracking-[0.2px] text-fg">
        <Icon name="sparkles" size={13} className="text-muted" /> LLM budget
      </p>
      <Meter value={latestRunShare} max={PER_RUN_CAP} />
      <p className="text-[11px] leading-relaxed text-subtle">
        {totals.calls} calls across {totals.runs} {totals.runs === 1 ? "run" : "runs"} · {PER_RUN_CAP} is the per-run cap.
      </p>
    </div>
  );
}
