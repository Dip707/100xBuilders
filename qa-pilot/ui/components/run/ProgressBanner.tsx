import Link from "next/link";
import type { RunProgress } from "@/lib/cases";
import type { RunRecord } from "@/lib/api";

/**
 * The reference's blue strip above an execution: what stage the run is at and how many
 * tests are done. Only the wording changes by state, the strip is always there so the
 * page never jumps when a run finishes.
 */
export function ProgressBanner({ run, progress, activeNode, awaitingReview, casesHref }: { run: RunRecord; progress: RunProgress; activeNode: string | null; awaitingReview: boolean; casesHref: string }) {
  const inFlight = run.status === "running" || run.status === "awaiting_review";
  let text: string;
  let icon = "⧗";
  let tone = "border-accent/30 bg-accent-tint text-accent";
  if (awaitingReview) {
    text = `Plan ready for review · ${progress.total} tests proposed · waiting for you`;
    icon = "☰";
    tone = "border-human/30 bg-human/10 text-human";
  } else if (inFlight && progress.total === 0) {
    text = `Run in progress · ${activeNode ? `${activeNode.replace("_", " ")} stage` : "starting"} · no tests planned yet`;
  } else if (inFlight) {
    text = `Test run in progress · ${progress.done} of ${progress.total} done · ${progress.running} running${activeNode && activeNode !== "run" ? ` · ${activeNode.replace("_", " ")} stage` : ""}`;
  } else if (run.status === "done") {
    text = `Test run complete · ${progress.done} of ${progress.total} done · ${progress.passed} passed`;
    icon = "✓";
  } else {
    text = `Test run ${run.status} · ${progress.done} of ${progress.total} done${run.partialReason ? ` · ${run.partialReason}` : ""}`;
    icon = run.status === "partial" ? "◑" : "✕";
    tone = "border-flaky/30 bg-flaky/10 text-flaky";
  }
  return (
    <div className={`flex items-center justify-between gap-4 border-y px-8 py-2.5 text-[14px] font-medium ${tone}`}>
      <p className="flex items-center gap-2"><span aria-hidden="true">{icon}</span>{text}</p>
      <Link href={casesHref} className="rounded-full border border-current/30 px-3 py-1 text-[13px] hover:bg-surface/60">View test cases</Link>
    </div>
  );
}
