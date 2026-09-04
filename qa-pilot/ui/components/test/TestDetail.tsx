"use client";
import { useEffect, useState } from "react";
import { Button, Spinner, StatusPill, Tabs } from "@/components/ui";
import { PriorityTag } from "@/components/cases/PriorityTag";
import { LivePreview } from "./LivePreview";
import { CodeView } from "./CodeView";
import { fileUrl, rerunTest } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { formatDuration, relativeTime } from "@/lib/format";
import {
  artifactRel, describeFlow, expectationLabel, latestScreenshotBy, liveFramePath, specPath, stepLabel, stepStates,
  CATEGORY_LABEL, type CaseRow, type StepState, type TestResultData,
} from "@/lib/cases";

const STEP_DOT: Record<StepState, string> = { passed: "bg-pass", failed: "bg-fail", pending: "bg-subtle", skipped: "bg-line-strong" };

function ResultCard({ row, rerunning }: { row: CaseRow; rerunning: boolean }) {
  const base = "rounded-box border px-4 py-3";
  if (rerunning || row.status === "running") {
    return (
      <div className={`${base} border-line bg-inset`}>
        <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner /> Test result</p>
        <p className="mt-1 text-[15px] font-semibold text-fg">Test running…</p>
      </div>
    );
  }
  if (row.status === "passed") {
    return (
      <div className={`${base} border-pass/30 bg-pass/10`}>
        <p className="text-[13px] text-pass">✓ Test result</p>
        <p className="mt-1 text-[15px] font-semibold text-pass">Test successful. No errors detected</p>
        {row.result?.durationMs !== undefined && <p className="mt-1 text-[12px] text-muted">{formatDuration(row.result.durationMs)}</p>}
      </div>
    );
  }
  if (row.status === "planned") {
    return (
      <div className={`${base} border-line bg-inset`}>
        <p className="text-[13px] text-muted">◌ Test result</p>
        <p className="mt-1 text-[15px] font-semibold text-fg">Not executed yet</p>
        <p className="mt-1 text-[13px] text-muted">The generator validates every step against the live app before this test runs.</p>
      </div>
    );
  }
  const c = row.classification;
  const failed = row.status === "failed";
  return (
    <div className={`${base} ${failed ? "border-fail/30 bg-fail/5" : "border-flaky/30 bg-flaky/5"}`}>
      <p className={`text-[13px] ${failed ? "text-fail" : "text-flaky"}`}>{failed ? "✕" : "◑"} Test result</p>
      <p className={`mt-1 text-[15px] font-semibold ${failed ? "text-fail" : "text-flaky"}`}>{failed ? "Test failed" : `Blocked: ${row.blockedReason ?? "not executed"}`}</p>
      {row.result?.error && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-input bg-surface p-2 font-mono text-[11px] leading-relaxed text-fg">{row.result.error}</pre>}
      {c && (
        <div className="mt-3 space-y-1.5">
          <p className="flex items-center gap-2 text-[13px] text-muted">Classified as <StatusPill status={c.class} suffix={c.confidence.toFixed(2)} /></p>
          {c.rationale && <p className="text-[13px] leading-relaxed text-fg">{c.rationale}</p>}
          {c.evidence && c.evidence.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-relaxed text-muted">{c.evidence.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

function StepCard({ index, tag, label, hint, state }: { index: number; tag: "action" | "assert"; label: string; hint?: string; state: StepState }) {
  return (
    <li className="relative rounded-box border border-line bg-surface px-4 py-3">
      <span className={`absolute -left-[5px] top-4 size-2 rounded-full ring-2 ring-surface ${STEP_DOT[state]}`} aria-hidden="true" />
      <p className="flex items-center gap-2 text-[12px] text-muted">
        Step {index}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tag === "action" ? "bg-inset text-fg" : "bg-accent-tint text-accent"}`}>{tag}</span>
        {state === "failed" && <span className="text-fail">failed here</span>}
        {state === "skipped" && <span className="text-subtle">not reached</span>}
      </p>
      <p className="mt-0.5 break-words text-[14px] font-medium text-fg">{label}</p>
      {hint && <p className="mt-0.5 text-[12px] text-muted">{hint}</p>}
    </li>
  );
}

function Preview({ row, runId, rerunning, events }: { row: CaseRow; runId: string; rerunning: boolean; events: ReturnType<typeof useRun>["events"] }) {
  const live = rerunning || row.status === "running";
  const video = artifactRel((row.result as TestResultData | undefined)?.videoPath, runId);
  if (live) return <LivePreview runId={runId} relPath={liveFramePath(row.id)} active fps={4} />;
  if (video) {
    return (
      <div className="overflow-hidden rounded-box border border-line bg-console">
        <video key={video} controls preload="metadata" src={fileUrl(runId, video)} className="aspect-[16/10] w-full" aria-label={`Recording of ${row.flow.title}`} />
      </div>
    );
  }
  const shot = latestScreenshotBy(events, runId, `generator:${row.id}`) ?? latestScreenshotBy(events, runId, `healer`);
  if (shot) {
    return (
      <div className="overflow-hidden rounded-box border border-line bg-console">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API path */}
        <img src={fileUrl(runId, shot)} alt={`Latest screenshot while preparing ${row.flow.title}`} className="aspect-[16/10] w-full object-contain" />
      </div>
    );
  }
  return <LivePreview runId={runId} relPath={liveFramePath(row.id)} active={false} />;
}

/**
 * The reference's test page as a drawer over the list: the test's title and status, its
 * basics, a step-by-step account of what ran, and next to it the browser - live while the
 * runner drives it, a recording once it has finished, the generated code on the other tab.
 */
export function TestDetail() {
  const { runId, run, rows, events, selectedTest, selectTest, pushEvent, refresh } = useRun();
  const row = rows.find((r) => r.id === selectedTest) ?? null;
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTest) return;
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") selectTest(null); };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [selectedTest, selectTest]);

  if (!selectedTest) return null;
  if (!row) {
    return (
      <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(64rem,66vw)] flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <p className="text-sm text-muted">{selectedTest}</p>
          <button onClick={() => selectTest(null)} aria-label="Close" className="rounded-full px-2 text-muted hover:bg-inset">»</button>
        </div>
        <p className="p-8 text-sm text-muted">This test is not in the current plan.</p>
      </aside>
    );
  }

  const { flow } = row;
  const states = stepStates(flow, row);
  const runFinished = run !== null && run.status !== "running" && run.status !== "awaiting_review";
  const trace = artifactRel(row.result?.tracePath, runId);
  const codeVersion = events.filter((e) => e.type === "node_end" && (e.node === "heal" || e.node === "generate")).length;

  async function rerun() {
    setRerunError(null);
    setRerunning(true);
    setTab("preview");
    pushEvent({ type: "test_start", runId, at: new Date().toISOString(), data: { id: row!.id, title: row!.flow.title } });
    try {
      const result = (await rerunTest(runId, row!.id)) as TestResultData;
      pushEvent({ type: "test_result", runId, at: new Date().toISOString(), message: `${result.id} ${result.status}`, data: result });
      refresh();
    } catch (err) {
      setRerunError((err as Error).message);
      pushEvent({ type: "test_result", runId, at: new Date().toISOString(), data: { ...(row!.result ?? { id: row!.id, status: "failed" }) } });
    } finally {
      setRerunning(false);
    }
  }

  return (
    <aside role="dialog" aria-label={flow.title} className="fixed inset-y-0 right-0 z-40 flex w-[min(64rem,66vw)] flex-col border-l border-line bg-surface shadow-2xl">
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <p className="text-sm text-muted">{row.useCase} <span className="mx-1.5 text-subtle">›</span> <span className="font-mono text-[13px]">{row.id}</span></p>
        <div className="flex items-center gap-2">
          {trace && <a href={fileUrl(runId, trace)} download><Button variant="outline" size="sm">Download trace</Button></a>}
          <Button variant="outline" size="sm" onClick={rerun} disabled={!runFinished || rerunning || row.status === "planned"} title={runFinished ? undefined : "Available once the run has finished"}>
            {rerunning ? <><Spinner /> Re-running</> : <>↻ Re-run</>}
          </Button>
          <button onClick={() => selectTest(null)} aria-label="Close" className="ml-1 rounded-full px-2 py-1 text-muted hover:bg-inset">»</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-6 pb-3 pt-5">
          <h2 className="text-[22px] font-semibold leading-tight text-fg">{flow.title}</h2>
          <div className="mt-2 flex items-center gap-2">
            <StatusPill status={rerunning ? "running" : row.status} />
            {row.at && !rerunning && <span className="text-[12px] text-subtle">updated {relativeTime(row.at)}</span>}
          </div>
          {rerunError && <p role="alert" className="mt-2 rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{rerunError}</p>}
        </div>

        <div className="grid gap-6 px-6 pb-8 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-6">
            <section>
              <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Basics</h3>
              <dl className="space-y-3 text-sm">
                <div><dt className="text-[12px] text-muted">Priority</dt><dd className="mt-1"><PriorityTag priority={flow.priority} /></dd></div>
                <div><dt className="text-[12px] text-muted">Category</dt><dd className="mt-1 text-fg">{CATEGORY_LABEL[flow.category]} · from {flow.source === "prd" ? "the PRD" : flow.source === "intent" ? "your intent" : "exploration"}</dd></div>
                <div><dt className="text-[12px] text-muted">Description</dt><dd className="mt-1 rounded-box border border-line bg-inset/60 px-3 py-2 leading-relaxed text-fg">{describeFlow(flow)}</dd></div>
              </dl>
            </section>

            <section>
              <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Execution steps ({flow.steps.length + flow.expected.length})</h3>
              <ResultCard row={row} rerunning={rerunning} />
              <ol className="ml-2 mt-4 space-y-2 border-l border-dashed border-line-strong pl-4">
                {flow.preconditions.includes("logged_in") && <StepCard index={0} tag="action" label="Sign in with the provided credentials" hint="precondition: logged in" state={states.steps[0] === "pending" ? "pending" : "passed"} />}
                {flow.steps.map((s, i) => <StepCard key={`s${i}`} index={i + 1} tag="action" label={stepLabel(s)} hint={s.intent} state={states.steps[i]} />)}
                {flow.expected.map((e, i) => <StepCard key={`e${i}`} index={flow.steps.length + i + 1} tag="assert" label={expectationLabel(e)} state={states.expectations[i]} />)}
              </ol>
            </section>
          </div>

          <div className="min-w-0 space-y-3">
            <Tabs tabs={[{ id: "preview" as const, label: "Preview" }, { id: "code" as const, label: "Code" }]} active={tab} onChange={setTab} />
            {tab === "preview" ? <Preview row={row} runId={runId} rerunning={rerunning} events={events} /> : <CodeView runId={runId} relPath={specPath(row.id)} version={codeVersion} />}
            {tab === "preview" && row.result && (
              <dl className="grid grid-cols-3 gap-3 text-[12px]">
                <div className="rounded-box border border-line px-3 py-2"><dt className="text-muted">Duration</dt><dd className="mt-0.5 font-medium text-fg">{formatDuration(row.result.durationMs)}</dd></div>
                <div className="rounded-box border border-line px-3 py-2"><dt className="text-muted">Failed requests</dt><dd className="mt-0.5 font-medium text-fg">{row.result.network?.length ?? 0}</dd></div>
                <div className="rounded-box border border-line px-3 py-2"><dt className="text-muted">Console errors</dt><dd className="mt-0.5 font-medium text-fg">{row.result.consoleErrors?.length ?? 0}</dd></div>
              </dl>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
