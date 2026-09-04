"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { StatCard } from "@/components/runs/StatCard";
import { RunTable } from "@/components/runs/RunTable";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
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
      <PageHeader
        crumbs={[{ label: "Overview" }]}
        title="Overview"
        subtitle="Every run this account has started, newest first. Open one to replay its pipeline, decisions, and report."
        actions={<Link href="/runs/new"><Button size="sm">Start a run</Button></Link>}
      />

      <div className="space-y-6 px-8 py-6">
        {error && <p role="alert" className="rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}

        {s && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Runs" value={String(s.runs)} />
            <StatCard label="Pass rate" value={s.passRate} hint={s.total ? `${s.total} tests executed` : undefined} />
            <StatCard label="Defects found" value={String(s.defects)} />
            <StatCard label="Heals applied" value={String(s.heals)} />
          </div>
        )}

        <Card title="Recent runs" padded={false}>
          {runs === null ? (
            <div className="flex justify-center py-14"><Spinner size={22} /></div>
          ) : runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              body="Point qa-pilot at a URL and it explores the app, plans tests, generates them, runs them, and repairs what breaks."
              action={<Link href="/runs/new"><Button>Start your first run</Button></Link>}
            />
          ) : (
            <RunTable runs={runs} />
          )}
        </Card>
      </div>
    </>
  );
}
