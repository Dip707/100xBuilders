"use client";
import { useEffect, useState } from "react";
import { Button, StatusPill } from "@/components/ui";
import { fileUrl, reportUrl, type ArtifactManifest, type RunRecord } from "@/lib/api";
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

export function RunHeader({ run, manifest }: { run: RunRecord; manifest: ArtifactManifest }) {
  const elapsed = useElapsed(run);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-8 pb-4 pt-6">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate font-mono text-lg font-semibold text-fg">{run.url}</h1>
          <StatusPill status={run.status} />
        </div>
        <p className="text-[13px] text-muted">
          started {relativeTime(run.startedAt)} · {elapsed}
          {run.intent && <> · {run.intent}</>}
        </p>
      </div>
      <div className="flex gap-2">
        <a href={reportUrl(run.id)} target="_blank" rel="noreferrer" aria-disabled={!manifest.hasReport}>
          <Button variant="outline" size="sm" disabled={!manifest.hasReport}>Open report</Button>
        </a>
        {manifest.traces.length > 0 && (
          <a href={fileUrl(run.id, `traces/${manifest.traces[0]}`)} download>
            <Button variant="outline" size="sm">Download trace</Button>
          </a>
        )}
      </div>
    </div>
  );
}
