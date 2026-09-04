"use client";
import Link from "next/link";
import { Icon } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { nextStage, stageHref, type StageId } from "@/lib/stages";

/**
 * The prompt that appears at the foot of a stage screen once the next stage has something
 * to show. It offers the move rather than making it: a run that navigated itself would
 * pull the page out from under anyone still reading the screen they chose.
 */
export function NextStageCta({ from }: { from: StageId }) {
  const { runId, stages } = useRun();
  const next = nextStage(stages, from);
  if (!next) return null;

  return (
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
  );
}
