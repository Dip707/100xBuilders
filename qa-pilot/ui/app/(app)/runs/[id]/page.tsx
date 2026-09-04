"use client";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, Icon, Spinner, Tabs, Wallpaper } from "@/components/ui";
import { RunHeader } from "@/components/run/RunHeader";
import { Pipeline } from "@/components/run/Pipeline";
import { Feed } from "@/components/run/Feed";
import { Decisions } from "@/components/run/Decisions";
import { PlanPanel } from "@/components/run/PlanPanel";
import { ReportFrame } from "@/components/run/ReportFrame";
import { BrowserCard } from "@/components/run/BrowserCard";
import { SummaryCard } from "@/components/run/SummaryCard";
import { ExecutionCard } from "@/components/run/ExecutionCard";
import { CaseTable } from "@/components/cases/CaseTable";
import { SearchBox } from "@/components/cases/SearchBox";
import { StageWaiting } from "@/components/stage/StageWaiting";
import { fileUrl, reportUrl, suiteUrl } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { activeNode, filterRows, runProgress } from "@/lib/cases";
import { decisionRows } from "@/lib/derive";

type View = "list" | "agent";
type AgentTab = "feed" | "decisions" | "plan" | "report";

/** The Test Runs screen: the execution summary, then the tests in this run, with the agent's own activity one tab away. */
export default function RunPage() {
  const { runId, run, manifest, error, events, rows, awaitingReview, selectedTest, selectTest, stages } = useRun();
  const stage = stages.find((s) => s.id === "runs")!;
  const [view, setView] = useState<View>("list");
  const [agentTab, setAgentTab] = useState<AgentTab>("feed");
  const [query, setQuery] = useState("");
  const progress = useMemo(() => runProgress(rows), [rows]);
  const node = activeNode(events);
  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Test runs" }];
  const casesHref = `/runs/${encodeURIComponent(runId)}/cases`;

  if (error) {
    return (
      <>
        <PageHeader crumbs={crumbs} />
        <p role="alert" className="m-6 flex items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
          <Icon name="alert" size={14} /> {error}
        </p>
      </>
    );
  }
  if (!run || !manifest) {
    return (<><PageHeader crumbs={crumbs} /><div className="flex justify-center p-16"><Spinner size={20} /></div></>);
  }

  if (stage.status === "not_started" || stage.status === "not_run") {
    return (<><PageHeader crumbs={crumbs} title="Test runs" /><StageWaiting id="runs" /></>);
  }

  const shown = filterRows(rows, { query });
  const agentTabs = [
    { id: "feed" as const, label: "Feed" },
    { id: "decisions" as const, label: "Decisions", badge: decisionRows(events).length },
    { id: "plan" as const, label: "Plan" },
    { id: "report" as const, label: "Report" },
  ];

  return (
    <>
      {/* One plate for every run screen: they are one workspace, not four pages. */}
      <Wallpaper name="drift" />
      {/* The run's artifacts live in the sticky bar, so they stay reachable while the list scrolls. */}
      <PageHeader
        crumbs={crumbs}
        actions={
          <>
            <a href={reportUrl(run.id)} target="_blank" rel="noreferrer" aria-disabled={!manifest.hasReport} tabIndex={manifest.hasReport ? undefined : -1}>
              <Button variant="outline" size="sm" disabled={!manifest.hasReport}><Icon name="file" size={13} /> Report</Button>
            </a>
            {manifest.hasSuite && (
              <a href={suiteUrl(run.id)} download title="The generated tests as a standalone Playwright project">
                <Button variant="outline" size="sm"><Icon name="download" size={13} /> Suite</Button>
              </a>
            )}
            {manifest.traces.length > 0 && (
              <a href={fileUrl(run.id, `traces/${manifest.traces[0]}`)} download>
                <Button variant="outline" size="sm"><Icon name="download" size={13} /> Trace</Button>
              </a>
            )}
          </>
        }
      />
      <RunHeader run={run} />

      <div className="space-y-5 px-6 pb-10">
        <ExecutionCard
          run={run} progress={progress} activeNode={node} awaitingReview={awaitingReview}
          hasReport={manifest.hasReport} casesHref={casesHref}
        />

        <div className="flex items-center gap-1 border-b border-line">
          {([["list", "List view"], ["agent", "Agent actions"]] as const).map(([id, label]) => (
            <button
              key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-[13.5px] font-medium tracking-[0.2px] transition-colors ${
                view === id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === "list" ? (
          <Card padded={false}>
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <SearchBox value={query} onChange={setQuery} />
              <span className="font-mono text-[12.5px] text-muted">{shown.length} of {rows.length}</span>
            </div>
            <CaseTable rows={shown} allRows={rows} mode="run" selected={selectedTest} onSelect={selectTest} emptyLabel={rows.length === 0 ? "No tests have been planned yet." : "No tests match."} />
          </Card>
        ) : (
          <>
            <div className="rounded-card border border-line bg-surface px-4 py-3"><Pipeline events={events} /></div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(19rem,1fr)]">
              <Card title="Agent activity" actions={<Tabs tabs={agentTabs} active={agentTab} onChange={setAgentTab} />} padded={false}>
                <div className="h-[min(60vh,34rem)] p-3">
                  {agentTab === "feed" && <Feed events={events} />}
                  {agentTab === "decisions" && <Decisions events={events} />}
                  {agentTab === "plan" && <PlanPanel runId={runId} available={manifest.files.includes("plan.md")} />}
                  {agentTab === "report" && <ReportFrame runId={runId} available={manifest.hasReport} />}
                </div>
              </Card>
              <div className="space-y-5 xl:sticky xl:top-[68px] xl:self-start">
                <BrowserCard events={events} runId={runId} />
                <SummaryCard run={run} />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
