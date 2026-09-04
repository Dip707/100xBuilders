import { reportUrl, type RunRecord } from "@/lib/api";
import type { RunProgress } from "@/lib/cases";
import { Spinner } from "@/components/ui";

function Stat({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-2 text-[14px] text-muted">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
      <span className="font-semibold text-fg">{value}</span> {label}
    </span>
  );
}

/**
 * The execution summary: when it started, the pass rate over finished tests, the count of
 * tests in each state, and a sentence saying what the pipeline is doing right now.
 */
export function ExecutionCard({ run, progress, activeNode, awaitingReview, hasReport }: { run: RunRecord; progress: RunProgress; activeNode: string | null; awaitingReview: boolean; hasReport: boolean }) {
  const started = new Date(run.startedAt);
  const inFlight = run.status === "running" || run.status === "awaiting_review";
  const rate = progress.passRate === null ? "–" : `${Math.round(progress.passRate * 100)}%`;

  const STAGE: Record<string, string> = {
    explore: "qa-pilot is exploring the app to map its pages, forms and gated routes.",
    plan: "The planner is writing flows and dry-walking each one against the live app.",
    evaluate_coverage: "The evaluator is scoring the plan for gaps before generation.",
    generate: "The generator is turning flows into Playwright tests, validating every selector live.",
    run: "Your tests are running. qa-pilot is clicking through the app scenarios now; the list below updates live.",
    classify: "The classifier is separating broken tests from genuine defects.",
    heal: "The healer is repairing broken locators and re-running the patched tests.",
    report: "Writing the final report.",
  };
  let headline: string;
  let body: string;
  if (awaitingReview) {
    headline = `${progress.total} tests proposed`;
    body = "The plan passed the coverage gate and is waiting for your review before anything is generated.";
  } else if (inFlight) {
    headline = progress.running > 0 ? `Running ${progress.running} ${progress.running === 1 ? "test" : "tests"}` : `${activeNode ? activeNode.replace("_", " ") : "Starting"}…`;
    body = STAGE[activeNode ?? ""] ?? "Waiting for the next stage to start.";
  } else {
    headline = run.status === "done" ? "Run finished" : `Run ${run.status}`;
    body = run.status === "done"
      ? `${progress.passed} passed, ${progress.failed} failed, ${progress.blocked} blocked. Open a test to see its steps, recording and generated code.`
      : run.partialReason ?? "The run stopped before every stage completed.";
  }

  return (
    <section className="rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
        <p className="text-[15px] font-semibold text-fg">Execution: {started.toLocaleDateString()} {started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
        <div className="flex flex-wrap items-center gap-6">
          <p className="text-[15px] text-muted"><span className="text-[26px] font-semibold text-fg">{rate}</span> Pass rate</p>
          <span className="h-6 w-px bg-line" aria-hidden="true" />
          <Stat dot="bg-accent" label="Running" value={progress.running} />
          <Stat dot="bg-pass" label="Passed" value={progress.passed} />
          <Stat dot="bg-fail" label="Failed" value={progress.failed} />
          <Stat dot="bg-flaky" label="Blocked" value={progress.blocked} />
          <Stat dot="bg-subtle" label="Total" value={progress.total} />
        </div>
      </div>
      <div className="space-y-1.5 px-6 py-4">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-accent">{inFlight && !awaitingReview ? <Spinner /> : null}{headline}</p>
        <p className="text-[15px] leading-relaxed text-fg">{body}</p>
        <p className="text-[13px] text-muted">
          The list below shows results from this run, not each test&apos;s latest.
          {hasReport && <> <a href={reportUrl(run.id)} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">Open report →</a></>}
        </p>
      </div>
    </section>
  );
}
