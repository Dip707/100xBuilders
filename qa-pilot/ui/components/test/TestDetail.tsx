"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Icon, Spinner, StatusPill, Tabs } from "@/components/ui";
import { PriorityTag } from "@/components/cases/PriorityTag";
import { LivePreview } from "./LivePreview";
import { RecordingPlayer } from "./RecordingPlayer";
import { CodeView } from "./CodeView";
import { fileUrl, rerunTest } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { formatDuration, relativeTime } from "@/lib/format";
import {
  artifactRel, classificationLabel, describeFlow, expectationLabel, latestScreenshotBy, liveFramePath, specPath, stepLabel, stepStates,
  CATEGORY_LABEL, type CaseRow, type StepState, type TestResultData,
} from "@/lib/cases";

const STEP_DOT: Record<StepState, string> = { passed: "bg-pass", failed: "bg-fail", pending: "bg-subtle", skipped: "bg-line" };

function ResultCard({ row, rerunning }: { row: CaseRow; rerunning: boolean }) {
  const base = "rounded-box border px-3.5 py-3";
  const heading = "flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.6px]";
  if (rerunning || row.status === "running") {
    return (
      <div className={`${base} border-line bg-inset`}>
        <p className={`${heading} text-muted`}><Spinner size={11} /> Test result</p>
        <p className="mt-1.5 text-[13.5px] font-medium text-fg">Test running…</p>
      </div>
    );
  }
  if (row.status === "passed") {
    return (
      <div className={`${base} border-pass/25 bg-pass/[0.08]`}>
        <p className={`${heading} text-pass`}><Icon name="check" size={12} /> Test result</p>
        <p className="mt-1.5 text-[13.5px] font-medium text-pass">Test successful. No errors detected</p>
        {row.result?.durationMs !== undefined && <p className="mt-1 font-mono text-[11.5px] text-muted">{formatDuration(row.result.durationMs)}</p>}
      </div>
    );
  }
  if (row.status === "planned") {
    return (
      <div className={`${base} border-line bg-inset`}>
        <p className={`${heading} text-muted`}><Icon name="dashedCircle" size={12} /> Test result</p>
        <p className="mt-1.5 text-[13.5px] font-medium text-fg">Not executed yet</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">The generator validates every step against the live app before this test runs.</p>
      </div>
    );
  }
  const c = row.classification;
  const failed = row.status === "failed";
  return (
    <div className={`${base} ${failed ? "border-fail/25 bg-fail/[0.07]" : "border-flaky/25 bg-flaky/[0.07]"}`}>
      <p className={`${heading} ${failed ? "text-fail" : "text-flaky"}`}>
        <Icon name={failed ? "x" : "halfCircle"} size={12} /> Test result
      </p>
      <p className={`mt-1.5 text-[13.5px] font-medium ${failed ? "text-fail" : "text-flaky"}`}>{failed ? "Test failed" : `Blocked: ${row.blockedReason ?? "not executed"}`}</p>
      {row.result?.error && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-input border border-line bg-console p-2 font-mono text-[11px] leading-relaxed text-[#cdcdcd]">{row.result.error}</pre>}
      {c && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-2.5">
          <p className="flex items-center gap-2 text-[12.5px] text-muted">Classified as <StatusPill status={classificationLabel(c)} suffix={c.confidence.toFixed(2)} /></p>
          {c.rationale && <p className="text-[12.5px] leading-relaxed text-body">{c.rationale}</p>}
          {c.evidence && c.evidence.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-muted">{c.evidence.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

function StepCard({ index, tag, label, hint, state }: { index: number; tag: "action" | "assert"; label: string; hint?: string; state: StepState }) {
  return (
    <li className="relative rounded-box border border-line bg-surface px-3.5 py-2.5">
      <span className={`absolute -left-[21px] top-4 size-1.5 rounded-full ring-4 ring-surface ${STEP_DOT[state]}`} aria-hidden="true" />
      <p className="flex items-center gap-2 text-[11.5px] text-muted">
        <span className="font-mono">Step {index}</span>
        <span className={`rounded-chip px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.4px] ${tag === "action" ? "bg-inset text-muted" : "bg-info/12 text-info"}`}>{tag}</span>
        {state === "failed" && <span className="text-fail">failed here</span>}
        {state === "skipped" && <span className="text-subtle">not reached</span>}
      </p>
      <p className="mt-1 break-words text-[13px] font-medium text-fg">{label}</p>
      {hint && <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{hint}</p>}
    </li>
  );
}

function Preview({ row, runId, rerunning, events }: { row: CaseRow; runId: string; rerunning: boolean; events: ReturnType<typeof useRun>["events"] }) {
  const live = rerunning || row.status === "running";
  const video = artifactRel((row.result as TestResultData | undefined)?.videoPath, runId);
  if (live) return <LivePreview runId={runId} relPath={liveFramePath(row.id)} active fps={4} />;
  if (video) return <RecordingPlayer key={video} src={fileUrl(runId, video)} label={row.flow.title} />;
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
 * One test's page, as it appears inside the drawer: title and status, its basics, a
 * step-by-step account of what ran, and next to it the browser - live while the runner
 * drives it, a recording once it has finished, the generated code on the other tab.
 *
 * Split from the drawer shell so the shell can stay mounted long enough to slide out.
 */
function Detail({ row, onClose }: { row: CaseRow; onClose: () => void }) {
  const { runId, run, events, pushEvent, refresh } = useRun();
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  const { flow } = row;
  const states = stepStates(flow, row);
  const runFinished = run !== null && run.status !== "running" && run.status !== "awaiting_review";
  const trace = artifactRel(row.result?.tracePath, runId);
  const codeVersion = events.filter((e) => e.type === "node_end" && (e.node === "heal" || e.node === "generate")).length;

  async function rerun() {
    setRerunError(null);
    setRerunning(true);
    setTab("preview");
    pushEvent({ type: "test_start", runId, at: new Date().toISOString(), data: { id: row.id, title: row.flow.title } });
    try {
      const result = (await rerunTest(runId, row.id)) as TestResultData;
      pushEvent({ type: "test_result", runId, at: new Date().toISOString(), message: `${result.id} ${result.status}`, data: result });
      refresh();
    } catch (err) {
      setRerunError((err as Error).message);
      pushEvent({ type: "test_result", runId, at: new Date().toISOString(), data: { ...(row.result ?? { id: row.id, status: "failed" }) } });
    } finally {
      setRerunning(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-2.5">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
          <span className="truncate">{row.useCase}</span>
          <Icon name="chevronRight" size={12} className="text-subtle" />
          <span className="font-mono text-fg">{row.id}</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {trace && (
            <a href={fileUrl(runId, trace)} download>
              <Button variant="outline" size="sm"><Icon name="download" size={13} /> Trace</Button>
            </a>
          )}
          <Button variant="outline" size="sm" onClick={rerun} disabled={!runFinished || rerunning || row.status === "planned"} title={runFinished ? undefined : "Available once the run has finished"}>
            {rerunning ? <><Spinner /> Re-running</> : <><Icon name="refresh" size={13} /> Re-run</>}
          </Button>
          <button onClick={onClose} aria-label="Close" className="flex size-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg">
            <Icon name="panelRight" size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-5 pb-4 pt-6">
          <h2 className="text-[21px] font-medium leading-tight tracking-[0.2px] text-fg">{flow.title}</h2>
          <div className="mt-2.5 flex items-center gap-2">
            <StatusPill status={rerunning ? "running" : row.status} />
            {row.at && !rerunning && <span className="text-[11.5px] text-subtle">updated {relativeTime(row.at)}</span>}
          </div>
          {rerunError && (
            <p role="alert" className="mt-3 flex items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
              <Icon name="alert" size={14} /> {rerunError}
            </p>
          )}
        </div>

        <div className="grid gap-6 px-5 pb-8 lg:grid-cols-[21rem_minmax(0,1fr)]">
          <div className="space-y-6">
            <section>
              <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Basics</h3>
              <dl className="space-y-3 text-[13px]">
                <div><dt className="text-[11.5px] text-muted">Priority</dt><dd className="mt-1.5"><PriorityTag priority={flow.priority} /></dd></div>
                <div><dt className="text-[11.5px] text-muted">Category</dt><dd className="mt-1 text-body">{CATEGORY_LABEL[flow.category]} · from {flow.source === "prd" ? "the PRD" : flow.source === "intent" ? "your intent" : "exploration"}</dd></div>
                <div><dt className="text-[11.5px] text-muted">Description</dt><dd className="mt-1.5 rounded-box border border-line bg-inset px-3 py-2 leading-relaxed text-body">{describeFlow(flow)}</dd></div>
              </dl>
            </section>

            <section>
              <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Execution steps ({flow.steps.length + flow.expected.length})</h3>
              <ResultCard row={row} rerunning={rerunning} />
              <ol className="ml-1 mt-4 space-y-2 border-l border-dashed border-line pl-5">
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
              <dl className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-box border border-line bg-surface text-[11.5px]">
                <div className="px-3 py-2.5"><dt className="text-muted">Duration</dt><dd className="mt-1 font-mono font-medium tabular-nums text-fg">{formatDuration(row.result.durationMs)}</dd></div>
                <div className="px-3 py-2.5"><dt className="text-muted">Failed requests</dt><dd className={`mt-1 font-mono font-medium tabular-nums ${row.result.network?.length ? "text-fail" : "text-fg"}`}>{row.result.network?.length ?? 0}</dd></div>
                <div className="px-3 py-2.5"><dt className="text-muted">Console errors</dt><dd className={`mt-1 font-mono font-medium tabular-nums ${row.result.consoleErrors?.length ? "text-fail" : "text-fg"}`}>{row.result.consoleErrors?.length ?? 0}</dd></div>
              </dl>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Matches the `.slide-over` transition in globals.css. */
const SLIDE_MS = 280;

/**
 * The test drawer.
 *
 * A panel that unmounts the moment it closes can only ever animate in - there is nothing
 * left in the DOM for the exit transition to run on. So closing is deferred: the click
 * flips `closing`, which drops `data-open` and starts the slide out, and only once that
 * has run does the selection actually clear and the panel unmount. The enter needs no
 * such trick, because `@starting-style` gives CSS the off-screen state to come from.
 */
export function TestDetail() {
  const { rows, selectedTest, selectTest } = useRun();
  const row = rows.find((r) => r.id === selectedTest) ?? null;
  const [closing, setClosing] = useState(false);

  // Read only inside callbacks, never during render: it exists so a deferred close cannot
  // wipe a selection the visitor made during the slide out.
  const currentId = useRef(selectedTest);
  useEffect(() => { currentId.current = selectedTest; }, [selectedTest]);

  const close = useCallback(() => {
    const closingId = currentId.current;
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      if (currentId.current === closingId) selectTest(null);
    }, SLIDE_MS);
  }, [selectTest]);

  useEffect(() => {
    if (!selectedTest) return;
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [selectedTest, close]);

  if (!selectedTest) return null;

  return (
    <>
      <div
        data-open={!closing} aria-hidden="true" onClick={close}
        className="slide-over-scrim fixed inset-0 z-30 bg-black/50"
      />
      <aside
        data-open={!closing} role="dialog" aria-label={row?.flow.title ?? selectedTest}
        className="slide-over fixed inset-y-0 right-0 z-40 flex w-[min(64rem,66vw)] flex-col border-l border-line bg-surface"
      >
        {row ? (
          <Detail key={row.id} row={row} onClose={close} />
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <p className="font-mono text-[13px] text-muted">{selectedTest}</p>
              <button onClick={close} aria-label="Close" className="flex size-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg">
                <Icon name="panelRight" size={15} />
              </button>
            </div>
            <p className="p-8 text-[13px] text-muted">This test is not in the current plan.</p>
          </>
        )}
      </aside>
    </>
  );
}
