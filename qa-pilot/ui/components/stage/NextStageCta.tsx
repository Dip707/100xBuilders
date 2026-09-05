"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { nextStage, stageHref, type StageId, type StageStatus } from "@/lib/stages";

/** How long the offer stands before a hand-off takes itself. Long enough to read the card and refuse it. */
const HANDOFF_MS = 6000;

/**
 * The prompt that appears at the foot of a stage screen once the next stage has something
 * to show.
 *
 * It normally offers the move rather than making it: a run that navigated itself would
 * pull the page out from under anyone still reading the screen they chose. `autoAdvance`
 * is the one exception, and it is narrow by construction - it arms only when this screen
 * watched its own stage finish, so someone who came back later to re-read a finished stage
 * is never moved, and the countdown can be refused. It exists because the stage that
 * follows a live one is where the run actually is, and the alternative is a user sitting
 * on a completed screen wondering whether anything is still happening.
 */
export function NextStageCta({ from, autoAdvance = false }: { from: StageId; autoAdvance?: boolean }) {
  const { runId, stages } = useRun();
  const router = useRouter();
  const here = stages.find((s) => s.id === from)!;
  const next = nextStage(stages, from);

  // Hooks run before the early return below, so the transition is still observed on the
  // renders where this component shows nothing - which is exactly when it happens: the next
  // stage starts in the same event that ends this one.
  const [seen, setSeen] = useState<StageStatus>(here.status);
  const [armed, setArmed] = useState(false);
  const [refused, setRefused] = useState(false);
  const [left, setLeft] = useState(HANDOFF_MS / 1000);
  if (seen !== here.status) {
    setSeen(here.status);
    if (autoAdvance && seen === "active" && here.status === "complete") setArmed(true);
  }
  const counting = armed && !refused && next?.status === "active";
  // Depended on by id rather than by object: `stages` rebuilds its entries on every event,
  // and an effect keyed on one would restart the countdown with each log line the run emits.
  const nextId = next?.id ?? null;

  // One timeout owns the hand-off and a separate interval only counts the label down, so a
  // tab that was throttled while in the background cannot navigate the instant it is
  // brought back to the front - the timeout it slept through fires on its own schedule.
  useEffect(() => {
    if (!counting || !nextId) return;
    const tick = setInterval(() => setLeft((s) => s - 1), 1000);
    const handoff = setTimeout(() => router.push(stageHref(runId, nextId)), HANDOFF_MS);
    return () => { clearInterval(tick); clearTimeout(handoff); };
  }, [counting, nextId, router, runId]);

  if (!next) return null;

  return (
    <div className="space-y-2">
      <Link
        href={stageHref(runId, next.id)}
        className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-box border border-line bg-inset text-muted">
          <Icon name={next.icon} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          {/*
            Imperative rather than "<label> is ready": the stage labels are a mix of singular
            and plural noun phrases ("Test coverage", "Test runs"), so no copula agrees with
            all four. The card only appears once the stage has started, which is the readiness
            signal on its own.
          */}
          <span className="block text-[13.5px] font-medium tracking-[0.1px] text-fg">
            Continue to {next.label}
            {next.status === "active" && <span className="ml-2 align-middle text-[10.5px] font-medium uppercase tracking-[0.5px] text-info">Live</span>}
          </span>
          {/*
            The stage's own blurb, never a sentence about what it produced: this fires as soon
            as the stage has started, and a run that stopped halfway through it would be told
            about results that were never written.
          */}
          <span className="block truncate text-[12px] text-muted">{next.blurb}</span>
        </span>
        {/* The whole row is the link, so this is an affordance rather than a nested button. */}
        <span className="flex h-8 items-center gap-1.5 rounded-input border border-line-strong px-3 text-[13px] font-medium tracking-[0.2px] text-fg">
          View <Icon name="arrowRight" size={13} />
        </span>
      </Link>
      {/*
        Outside the card, because the refusal is a button and a button inside an anchor is
        neither valid nor operable by keyboard.
      */}
      {counting && (
        <p className="flex items-center gap-2 px-1 text-[12px] text-muted">
          <Icon name="clock" size={12} />
          <span aria-live="polite">Opening {next.label} in {Math.max(0, left)}s</span>
          <button
            type="button" onClick={() => setRefused(true)}
            className="rounded-input border border-line px-2 py-0.5 text-[12px] text-fg transition-colors hover:bg-selected"
          >
            Stay here
          </button>
        </p>
      )}
    </div>
  );
}
