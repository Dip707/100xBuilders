"use client";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/ui";
import { type RunRecord } from "@/lib/api";
import { formatDuration, relativeTime } from "@/lib/format";

/** Elapsed time for a run still in flight; the stored duration once it has finished. */
function useElapsed(run: RunRecord): string {
  const [now, setNow] = useState(() => Date.now());
  const live = run.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return live ? formatDuration(now - Date.parse(run.startedAt)) : formatDuration(run.durationMs);
}

/**
 * The run's identity: what was tested, and how it went. The artifact buttons that used to
 * sit here now live in the sticky page header, so this is a subject line rather than a
 * third toolbar.
 */
export function RunHeader({ run }: { run: RunRecord }) {
  const elapsed = useElapsed(run);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-5 pt-7">
      <h1 className="min-w-0 truncate font-mono text-[19px] font-medium tracking-[-0.2px] text-fg">{run.url}</h1>
      <StatusPill status={run.status} />
      <p className="w-full text-[12.5px] text-muted">
        started {relativeTime(run.startedAt)} · <span className="font-mono">{elapsed}</span>
        {run.intent && <> · {run.intent}</>}
      </p>
    </div>
  );
}
