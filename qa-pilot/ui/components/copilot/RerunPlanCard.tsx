"use client";
import { Icon, Spinner } from "@/components/ui";
import type { RerunPlanData } from "@/lib/api";
import type { LiveStatus } from "@/lib/copilot";

const LABEL: Record<LiveStatus, string> = { queued: "Queued", running: "Running", passed: "Passed", failed: "Failed" };
const TONE: Record<LiveStatus, string> = { queued: "text-subtle", running: "text-info", passed: "text-pass", failed: "text-fail" };

function StatusMark({ status }: { status: LiveStatus }) {
  if (status === "running") return <Spinner size={11} />;
  if (status === "passed") return <Icon name="check" size={12} />;
  if (status === "failed") return <Icon name="x" size={12} />;
  return <Icon name="dashedCircle" size={12} />;
}

/**
 * The tests a turn decided to rerun. Before execution it is a list; while the rerun runs each
 * row carries its live status from the run's event stream; the stored result table that
 * follows it in the transcript is the outcome.
 */
export function RerunPlanCard({ plan, statuses, live }: { plan: RerunPlanData; statuses: Record<string, LiveStatus> | null; live: boolean }) {
  const count = plan.testIds.length;
  return (
    <div className="rounded-box border border-line bg-inset px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12px] text-muted">
        <Icon name="refresh" size={12} /> {live ? "Re-running" : "Rerun"} {count} {count === 1 ? "test" : "tests"} in <span className="font-mono">{plan.runId}</span>
      </p>
      <ul className="mt-2 space-y-1">
        {plan.testIds.map((id) => {
          const status = statuses?.[id] ?? "queued";
          return (
            <li key={id} className="flex items-center gap-2 text-[13px]">
              <span className={`inline-flex w-4 justify-center ${TONE[status]}`}><StatusMark status={status} /></span>
              <span className="font-mono text-fg">{id}</span>
              {statuses && <span className={`ml-auto text-[11.5px] ${TONE[status]}`}>{LABEL[status]}</span>}
            </li>
          );
        })}
      </ul>
      {plan.blocked.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2">
          {plan.blocked.map((b) => (
            <li key={b.id} className="flex items-start gap-2 text-[12.5px] text-muted">
              <Icon name="ban" size={12} className="mt-0.5 shrink-0" />
              <span><span className="font-mono text-fg">{b.id}</span> {b.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
