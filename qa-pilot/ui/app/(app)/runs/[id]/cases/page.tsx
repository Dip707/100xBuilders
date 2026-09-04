"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, Icon, Spinner, Wallpaper } from "@/components/ui";
import { CaseTable } from "@/components/cases/CaseTable";
import { StatusChips } from "@/components/cases/StatusChips";
import { SearchBox } from "@/components/cases/SearchBox";
import { NextStageCta } from "@/components/stage/NextStageCta";
import { StageWaiting } from "@/components/stage/StageWaiting";
import { rerunTest } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { filterRows, statusCounts, type CaseStatus, type TestResultData } from "@/lib/cases";

/** The reference's Test Cases screen: every planned test, grouped by use case, with its latest status. */
export default function CasesPage() {
  const { runId, run, error, rows, plan, selectedTest, selectTest, pushEvent, refresh, stages } = useRun();
  const stage = stages.find((s) => s.id === "cases")!;
  const router = useRouter();
  const [status, setStatus] = useState<CaseStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [rerunAll, setRerunAll] = useState<{ done: number; total: number } | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const counts = useMemo(() => statusCounts(rows), [rows]);
  const shown = useMemo(() => filterRows(rows, { status, query }), [rows, status, query]);
  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Test cases" }];
  const finished = run !== null && run.status !== "running" && run.status !== "awaiting_review";
  const rerunnable = rows.filter((r) => r.status !== "planned");

  /** Re-executes every generated test, one at a time so the live preview follows along. */
  async function runAll() {
    setRerunError(null);
    setRerunAll({ done: 0, total: rerunnable.length });
    for (const [i, r] of rerunnable.entries()) {
      pushEvent({ type: "test_start", runId, at: new Date().toISOString(), data: { id: r.id, title: r.flow.title } });
      try {
        const result = (await rerunTest(runId, r.id)) as TestResultData;
        pushEvent({ type: "test_result", runId, at: new Date().toISOString(), message: `${result.id} ${result.status}`, data: result });
      } catch (err) {
        setRerunError((err as Error).message);
        pushEvent({ type: "test_result", runId, at: new Date().toISOString(), data: r.result ?? { id: r.id, status: "skipped" } });
        break;
      } finally {
        setRerunAll({ done: i + 1, total: rerunnable.length });
      }
    }
    setRerunAll(null);
    refresh();
  }

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

  if (stage.status === "not_started" || stage.status === "not_run") {
    return (<><PageHeader crumbs={crumbs} title="Test cases" /><StageWaiting id="cases" /></>);
  }

  return (
    <>
      <Wallpaper name="drift" />
      <PageHeader crumbs={crumbs} title="Test cases" subtitle="All test cases, grouped by use case. Open one to see its steps, the browser recording and the generated code." />
      <div className="space-y-4 px-6 pb-10 pt-5">
        <StatusChips counts={counts} active={status} onChange={setStatus} />
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-3">
              <SearchBox value={query} onChange={setQuery} />
              <span className="font-mono text-[12.5px] text-muted">{shown.length} of {rows.length}</span>
            </div>
            <div className="flex items-center gap-2">
              {rerunError && <p role="alert" className="text-[12.5px] text-fail">{rerunError}</p>}
              <Button variant="outline" size="sm" onClick={() => router.push(`/runs/${encodeURIComponent(runId)}/coverage`)}>
                <Icon name="target" size={13} /> View coverage
              </Button>
              <Button size="sm" onClick={runAll} disabled={!finished || rerunAll !== null || rerunnable.length === 0} title={finished ? undefined : "Available once the run has finished"}>
                {rerunAll ? <><Spinner /> {rerunAll.done}/{rerunAll.total}</> : <><Icon name="play" size={13} /> Run all</>}
              </Button>
            </div>
          </div>
          {plan === null ? <div className="flex justify-center py-16"><Spinner size={20} /></div> : (
            <CaseTable
              rows={shown} allRows={rows} mode="cases" selected={selectedTest} onSelect={selectTest}
              onViewCoverage={(useCase) => router.push(`/runs/${encodeURIComponent(runId)}/coverage?lane=${encodeURIComponent(useCase)}`)}
              emptyLabel={rows.length === 0 ? "No test cases yet." : "No tests match."}
            />
          )}
        </Card>

        <NextStageCta from="cases" />
      </div>
    </>
  );
}
