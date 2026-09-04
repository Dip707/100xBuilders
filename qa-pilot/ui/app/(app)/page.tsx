"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { Metric, MetricStrip } from "@/components/runs/StatCard";
import { RunTable } from "@/components/runs/RunTable";
import { Button, Card, EmptyState, Icon, Keycap, Spinner, Wallpaper } from "@/components/ui";
import { listRuns, type RunRecord } from "@/lib/api";

function stats(runs: RunRecord[]) {
  const finished = runs.filter((r) => r.testsPassed !== undefined);
  const passed = finished.reduce((n, r) => n + (r.testsPassed ?? 0), 0);
  const failed = finished.reduce((n, r) => n + (r.testsFailed ?? 0), 0);
  const total = passed + failed;
  return {
    runs: runs.length,
    passRate: total === 0 ? "-" : `${Math.round((passed / total) * 100)}%`,
    defects: runs.reduce((n, r) => n + (r.defectsCount ?? 0), 0),
    heals: runs.reduce((n, r) => n + (r.healsAccepted ?? 0), 0),
    total,
  };
}

export default function OverviewPage() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns).catch((err) => setError((err as Error).message));
  }, []);

  const s = runs ? stats(runs) : null;

  return (
    <>
      <Wallpaper name="ridge" />
      <PageHeader
        crumbs={[{ label: "Overview" }]}
        title="Overview"
        subtitle="Every run this account has started, newest first. Open one to replay its pipeline, decisions, and report."
        actions={
          <Link href="/runs/new">
            <Button size="sm"><Icon name="plus" size={14} /> Start a run</Button>
          </Link>
        }
      />

      <div className="space-y-5 px-6 py-6">
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}

        {s && (
          <MetricStrip>
            <Metric label="Runs" value={String(s.runs)} hint={`${s.runs === 1 ? "run" : "runs"} on this account`} />
            <Metric label="Pass rate" value={s.passRate} hint={s.total ? `${s.total} tests executed` : undefined} />
            <Metric label="Defects found" value={String(s.defects)} hint="classified as app bugs" />
            <Metric label="Heals applied" value={String(s.heals)} hint="repairs the healer accepted" />
          </MetricStrip>
        )}

        <Card
          title="Recent runs"
          padded={false}
          actions={
            <span className="hidden items-center gap-1.5 text-[12px] text-subtle sm:flex">
              <Keycap>⌘K</Keycap> to jump to a run
            </span>
          }
        >
          {runs === null ? (
            <div className="flex justify-center py-16"><Spinner size={20} /></div>
          ) : runs.length === 0 ? (
            <EmptyState
              icon="flask"
              title="No runs yet"
              body="Point qa-pilot at a URL and it explores the app, plans tests, generates them, runs them, and repairs what breaks."
              action={<Link href="/runs/new"><Button><Icon name="plus" size={14} /> Start your first run</Button></Link>}
            />
          ) : (
            <RunTable runs={runs} />
          )}
        </Card>
      </div>
    </>
  );
}
