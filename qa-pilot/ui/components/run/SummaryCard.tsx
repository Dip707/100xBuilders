import { Card, Meter } from "@/components/ui";
import type { RunRecord } from "@/lib/api";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-[13px] last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="font-mono font-medium tabular-nums text-fg">{value}</span>
    </div>
  );
}

export function SummaryCard({ run }: { run: RunRecord }) {
  const budget = 200; // the API's default maxLlmCalls; the run record stores the count, not the cap
  return (
    <Card title="Summary">
      <div className="py-1">
        {run.coverageScore != null && (
          <div className="border-b border-line py-3">
            <Meter value={run.coverageScore} label="Coverage" fill={run.coverageScore >= 0.75 ? "bg-pass" : "bg-flaky"} />
          </div>
        )}
        <Row label="Flows planned" value={run.flowsTotal ?? "-"} />
        <Row label="Plan iterations" value={run.planIterations ?? "-"} />
        <Row
          label="Tests"
          value={run.testsPassed == null ? "-" : (
            <><span className="text-pass">{run.testsPassed}</span>{run.testsFailed ? <span className="text-fail"> / {run.testsFailed}</span> : null}</>
          )}
        />
        <Row label="Heals accepted" value={run.healsAccepted ?? "-"} />
        <Row label="Defects escalated" value={<span className={run.defectsCount ? "text-defect" : undefined}>{run.defectsCount ?? "-"}</span>} />
        <Row label="LLM calls" value={run.llmCalls == null ? "-" : `${run.llmCalls} / ${budget}`} />
        {run.partialReason && <Row label="Stopped because" value={<span className="font-sans text-flaky">{run.partialReason}</span>} />}
      </div>
    </Card>
  );
}
