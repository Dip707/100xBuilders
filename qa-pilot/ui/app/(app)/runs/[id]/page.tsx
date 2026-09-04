"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Spinner, Tabs } from "@/components/ui";
import { RunHeader } from "@/components/run/RunHeader";
import { Pipeline } from "@/components/run/Pipeline";
import { Feed } from "@/components/run/Feed";
import { Decisions } from "@/components/run/Decisions";
import { Results } from "@/components/run/Results";
import { PlanPanel } from "@/components/run/PlanPanel";
import { ReportFrame } from "@/components/run/ReportFrame";
import { BrowserCard } from "@/components/run/BrowserCard";
import { SummaryCard } from "@/components/run/SummaryCard";
import { useRunEvents } from "@/lib/events";
import { decisionRows, isDone, testRows } from "@/lib/derive";
import { getRun, type ArtifactManifest, type RunRecord } from "@/lib/api";

type TabId = "feed" | "decisions" | "results" | "plan" | "report";

export default function RunPage() {
  const runId = String(useParams().id);
  const [record, setRecord] = useState<{ run: RunRecord; manifest: ArtifactManifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("feed");

  // The stream is identical for a live run and a stored one: /events/:id replays
  // events.jsonl before it subscribes, so this page needs no replay-specific branch.
  const events = useRunEvents(runId);
  const done = isDone(events);

  useEffect(() => {
    getRun(runId).then(setRecord).catch((err) => setError((err as Error).message));
  }, [runId]);

  // Re-read the record once the run finishes so the summary and the manifest reflect it.
  useEffect(() => {
    if (!done) return;
    getRun(runId).then(setRecord).catch(() => {});
  }, [done, runId]);

  if (error) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: runId }]} />
        <p role="alert" className="m-8 rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>
      </>
    );
  }
  if (!record) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: runId }]} />
        <div className="flex justify-center p-16"><Spinner size={22} /></div>
      </>
    );
  }

  const tabs = [
    { id: "feed" as const, label: "Feed" },
    { id: "decisions" as const, label: "Decisions", badge: decisionRows(events).length },
    { id: "results" as const, label: "Results", badge: testRows(events).length },
    { id: "plan" as const, label: "Plan" },
    { id: "report" as const, label: "Report" },
  ];

  return (
    <>
      <PageHeader crumbs={[{ label: "Runs", href: "/" }, { label: record.run.id }]} />
      <RunHeader run={record.run} manifest={record.manifest} />

      <div className="border-y border-line bg-app px-8 py-3">
        <Pipeline events={events} />
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <Card title="Agent activity" actions={<Tabs tabs={tabs} active={tab} onChange={setTab} />} padded={false}>
          {/* One height for every panel, sized against the viewport, so no panel is a stubby fixed box. */}
          <div className="h-[min(60vh,34rem)] p-3">
            {tab === "feed" && <Feed events={events} />}
            {tab === "decisions" && <Decisions events={events} />}
            {tab === "results" && <Results events={events} />}
            {tab === "plan" && <PlanPanel runId={runId} available={record.manifest.files.includes("plan.md")} />}
            {tab === "report" && <ReportFrame runId={runId} available={record.manifest.hasReport} />}
          </div>
        </Card>

        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <BrowserCard events={events} runId={runId} />
          <SummaryCard run={record.run} />
        </div>
      </div>
    </>
  );
}
