import Link from "next/link";
import { reportUrl, type RunRecord } from "@/lib/api";
import type { RunProgress } from "@/lib/cases";
import { Icon, Meter, Spinner, type IconName } from "@/components/ui";

function Stat({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted">
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      <span className="font-medium tabular-nums text-fg">{value}</span> {label}
    </span>
  );
}

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

/**
 * The execution summary. This used to be two stacked bands - a coloured progress strip
 * and a card that repeated most of it - which meant a run page opened with four full-width
 * headers before any content. They are one block now: the numbers on top, the sentence
 * saying what the pipeline is doing right now underneath, and a hairline progress track
 * across the bottom.
 */
export function ExecutionCard({
  run, progress, activeNode, awaitingReview, hasReport, casesHref,
}: {
  run: RunRecord;
  progress: RunProgress;
  activeNode: string | null;
  awaitingReview: boolean;
  hasReport: boolean;
  casesHref: string;
}) {
  const started = new Date(run.startedAt);
  const inFlight = run.status === "running" || run.status === "awaiting_review";
  const rate = progress.passRate === null ? "–" : `${Math.round(progress.passRate * 100)}%`;

  let headline: string;
  let body: string;
  let tone = "text-fg";
  let icon: IconName = "clock";
  // A solid white bar at 100% shouted louder than anything else on the page; the track
  // carries the outcome instead, which is the one thing worth that much contrast.
  let fill = "bg-fg";
  if (awaitingReview) {
    headline = `${progress.total} tests proposed`;
    body = "The plan passed the coverage gate and is waiting for your review before anything is generated.";
    tone = "text-human";
    icon = "clipboard";
    fill = "bg-human";
  } else if (inFlight) {
    headline = progress.running > 0 ? `Running ${progress.running} ${progress.running === 1 ? "test" : "tests"}` : `${activeNode ? activeNode.replace("_", " ") : "Starting"}…`;
    body = STAGE[activeNode ?? ""] ?? "Waiting for the next stage to start.";
    tone = "text-info";
    fill = "bg-info";
  } else if (run.status === "done") {
    headline = "Run finished";
    body = `${progress.passed} passed, ${progress.failed} failed, ${progress.blocked} blocked. Open a test to see its steps, recording and generated code.`;
    tone = "text-pass";
    icon = "check";
    fill = progress.failed > 0 ? "bg-flaky" : "bg-pass";
  } else {
    headline = `Run ${run.status}`;
    body = run.partialReason ?? "The run stopped before every stage completed.";
    tone = run.status === "partial" ? "text-flaky" : "text-fail";
    icon = run.status === "partial" ? "halfCircle" : "x";
    fill = run.status === "partial" ? "bg-flaky" : "bg-fail";
  }

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-3.5">
        <p className="text-[13px] text-muted">
          Execution{" "}
          <span className="font-mono text-fg">
            {started.toLocaleDateString()} {started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <p className="flex items-baseline gap-1.5 text-[13px] text-muted">
            <span className="text-[22px] font-medium leading-none tabular-nums tracking-[-0.4px] text-fg">{rate}</span> pass rate
          </p>
          <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
          <Stat dot="bg-info" label="running" value={progress.running} />
          <Stat dot="bg-pass" label="passed" value={progress.passed} />
          <Stat dot="bg-fail" label="failed" value={progress.failed} />
          <Stat dot="bg-flaky" label="blocked" value={progress.blocked} />
          <Stat dot="bg-subtle" label="total" value={progress.total} />
        </div>
      </div>

      <div className="space-y-2 px-5 py-4">
        <p className={`flex items-center gap-2 text-sm font-medium tracking-[0.2px] ${tone}`}>
          {inFlight && !awaitingReview ? <Spinner /> : <Icon name={icon} size={14} />}
          {headline}
        </p>
        <p className="max-w-3xl text-[13.5px] leading-relaxed text-body">{body}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
          <span>The list below shows results from this run, not each test&apos;s latest.</span>
          <Link href={casesHref} className="inline-flex items-center gap-1 font-medium text-fg underline-offset-4 hover:underline">
            View test cases <Icon name="arrowRight" size={12} />
          </Link>
          {hasReport && (
            <a href={reportUrl(run.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline-offset-4 hover:underline">
              Open report <Icon name="externalLink" size={12} />
            </a>
          )}
        </p>
      </div>

      {progress.total > 0 && (
        <div className="px-5 pb-4">
          <Meter value={progress.done} max={progress.total} label={`${progress.done} of ${progress.total} tests done`} fill={fill} />
        </div>
      )}
    </section>
  );
}
