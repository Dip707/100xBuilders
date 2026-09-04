"use client";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Spinner, Tabs } from "@/components/ui";
import { RunHeader } from "@/components/run/RunHeader";
import { Pipeline } from "@/components/run/Pipeline";
import { Feed } from "@/components/run/Feed";
import { Decisions } from "@/components/run/Decisions";
import { PlanPanel } from "@/components/run/PlanPanel";
import { ReportFrame } from "@/components/run/ReportFrame";
import { BrowserCard } from "@/components/run/BrowserCard";
import { SummaryCard } from "@/components/run/SummaryCard";
import { ProgressBanner } from "@/components/run/ProgressBanner";
import { ExecutionCard } from "@/components/run/ExecutionCard";
import { CaseTable } from "@/components/cases/CaseTable";
import { SearchBox } from "@/components/cases/SearchBox";
import { useRun } from "@/lib/run-context";
import { activeNode, filterRows, runProgress } from "@/lib/cases";
import { decisionRows } from "@/lib/derive";

type View = "list" | "agent";
type AgentTab = "feed" | "decisions" | "plan" | "report";

/** The reference's Test Runs screen: the execution strip and card, then the list of tests in this run, with the agent's own activity one tab away. */
export default function RunPage() {
  const { runId, run, manifest, error, events, rows, awaitingReview, selectedTest, selectTest } = useRun();
  const [view, setView] = useState<View>("list");
  const [agentTab, setAgentTab] = useState<AgentTab>("feed");
  const [query, setQuery] = useState("");
  const progress = useMemo(() => runProgress(rows), [rows]);
  const node = activeNode(events);
  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Test runs" }];

  if (error) {
    return (<><PageHeader crumbs={crumbs} /><p role="alert" className="m-8 rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p></>);
  }
  if (!run || !manifest) {
    return (<><PageHeader crumbs={crumbs} /><div className="flex justify-center p-16"><Spinner size={22} /></div></>);
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
      <PageHeader crumbs={crumbs} />
      <ProgressBanner run={run} progress={progress} activeNode={node} awaitingReview={awaitingReview} casesHref={`/runs/${encodeURIComponent(runId)}/cases`} />
      <RunHeader run={run} manifest={manifest} />

      <div className="space-y-6 px-8 pb-10">
        <ExecutionCard run={run} progress={progress} activeNode={node} awaitingReview={awaitingReview} hasReport={manifest.hasReport} />

        <div className="flex items-center gap-1 border-b border-line">
          {([["list", "List view"], ["agent", "Agent actions view"]] as const).map(([id, label]) => (
            <button
              key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-[15px] font-medium transition-colors ${view === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === "list" ? (
          <Card padded={false}>
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <SearchBox value={query} onChange={setQuery} />
              <span className="text-[13px] text-muted">{shown.length} of {rows.length}</span>
            </div>
            <CaseTable rows={shown} allRows={rows} mode="run" selected={selectedTest} onSelect={selectTest} emptyLabel={rows.length === 0 ? "No tests have been planned yet." : "No tests match."} />
          </Card>
        ) : (
          <>
            <div className="rounded-card border border-line bg-app px-6 py-3"><Pipeline events={events} /></div>
            <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
              <Card title="Agent activity" actions={<Tabs tabs={agentTabs} active={agentTab} onChange={setAgentTab} />} padded={false}>
                <div className="h-[min(60vh,34rem)] p-3">
                  {agentTab === "feed" && <Feed events={events} />}
                  {agentTab === "decisions" && <Decisions events={events} />}
                  {agentTab === "plan" && <PlanPanel runId={runId} available={manifest.files.includes("plan.md")} />}
                  {agentTab === "report" && <ReportFrame runId={runId} available={manifest.hasReport} />}
                </div>
              </Card>
              <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
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
