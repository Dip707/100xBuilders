"use client";
import { useEffect, useRef, useState } from "react";
import { Icon, Meter, Spinner } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import type { PlannerFlow, PlannerProgress as Progress } from "@/lib/planner";

/*
 * What the Test coverage screen shows while the planner is still writing the plan.
 *
 * The plan node is the longest silence in a run and it produces its artifact only at the
 * very end, so the screen used to sit on "The planner has not produced any flows yet." for
 * two minutes - the one moment in a run where the app most looks broken. Everything here
 * is the work that was already happening and simply had nowhere to appear: the routes the
 * planner is reading, the flows it proposed, its browser walking each one, and which of
 * them survived.
 */

const STATUS: Record<PlannerFlow["status"], { icon: "dashedCircle" | "clock" | "wand" | "check" | "x"; tone: string; label: string }> = {
  pending: { icon: "dashedCircle", tone: "text-subtle", label: "queued" },
  walking: { icon: "clock", tone: "text-info", label: "walking" },
  repairing: { icon: "wand", tone: "text-flaky", label: "repairing" },
  kept: { icon: "check", tone: "text-pass", label: "kept" },
  dropped: { icon: "x", tone: "text-fail", label: "dropped" },
};

/** Ticks once a second so the elapsed clock moves; the planner's own events are far too sparse to drive it. */
function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return startedAt ? formatDuration(now - Date.parse(startedAt)) : "-";
}

/** The planner's browser while it dry-walks, with the step it is on underneath. */
function LiveViewport({ src, action }: { src: string | null; action: string | null }) {
  return (
    <div className="overflow-hidden rounded-box border border-line bg-surface">
      {/* The mat is dark in both themes, as on Sources: it is a browser viewport, not a panel. */}
      <div className="relative aspect-[8/5] w-full bg-console">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- a base64 frame off the wire, not an asset Next can optimise
          <img src={src} alt="Live view of the planner's browser" className="size-full object-contain" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-subtle">
            <Icon name="book" size={18} />
            The planner has not opened a browser yet.
          </div>
        )}
        {src && (
          <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-chip border border-line bg-app/85 px-2 py-1 text-[10.5px] font-medium uppercase leading-none tracking-[0.6px] text-fg backdrop-blur">
            <span className="size-1.5 animate-pulse rounded-full bg-[#ff6161]" aria-hidden="true" />
            Live
          </span>
        )}
      </div>
      <p className="truncate border-t border-line px-3 py-2 font-mono text-[11.5px] text-muted">{action ?? "waiting for the first step…"}</p>
    </div>
  );
}

/**
 * An indeterminate track, for the stretch of the run whose only honest progress report is
 * "still going". A determinate meter here would have to invent a percentage: the model is
 * inside one call and tells us nothing until it returns.
 */
function Sweep({ label }: { label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] tracking-[0.4px] text-muted">{label}</p>
      <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label={label} aria-busy="true">
        <div className="h-full w-1/3 animate-sweep rounded-full bg-fg" />
      </div>
    </div>
  );
}

/**
 * The routes the crawl found, listed while the planner reads them and there is nothing else
 * to show.
 *
 * The panel carries the wait, so it moves: a beam crossing the header and the chips lighting
 * one after another, staggered so the row reads as a pass over the crawl rather than a dozen
 * things blinking at once. This used to be a static list beside an 11px spinner, which at a
 * glance was indistinguishable from a hung screen.
 */
function Routes({ routes }: { routes: string[] }) {
  return (
    <div className="overflow-hidden rounded-box border border-line bg-inset">
      <div className="relative flex items-center gap-2 border-b border-line px-3 py-2">
        <Spinner size={13} />
        <h3 className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Reading the crawl</h3>
        <span className="ml-auto font-mono text-[11px] text-subtle">{routes.length}</span>
        {/* A beam along the header rule: the one piece of motion wide enough to read from across a room. */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
          <span className="block h-full w-1/3 animate-sweep bg-gradient-to-r from-transparent via-fg to-transparent" />
        </span>
      </div>
      <div className="p-3">
        <ul className="flex flex-wrap gap-1.5">
          {routes.map((r, i) => (
            <li
              key={r}
              className="animate-chip-scan rounded-chip border border-line bg-surface px-2 py-1 font-mono text-[11.5px] text-body"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              {r}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          Each page, form and gated route goes to the planner in one pass, so it can write flows that cross
          between them rather than one page at a time.
        </p>
      </div>
    </div>
  );
}

/**
 * The rows the flows will land in, one per flow the planner is allowed to write.
 *
 * Shaped like the real list underneath - title line, id line, status - so the panel does not
 * reflow when the model returns, and counted from the run's own flow budget so the wait shows
 * how much plan is coming rather than a guess.
 */
function FlowSkeleton({ count }: { count: number }) {
  return (
    <ol aria-hidden="true" className="min-h-0 flex-1">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-0">
          <span className="mt-1 size-3 shrink-0 animate-shimmer rounded-full bg-raised" style={{ animationDelay: `${i * 180}ms` }} />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-2.5 animate-shimmer rounded-chip bg-raised" style={{ animationDelay: `${i * 180 + 60}ms`, width: `${88 - i * 11}%` }} />
            <span className="block h-2 w-1/3 animate-shimmer rounded-chip bg-raised" style={{ animationDelay: `${i * 180 + 120}ms` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The proposed flows, each moving from queued to kept or dropped as its dry walk decides. */
function FlowList({ flows }: { flows: PlannerFlow[] }) {
  const list = useRef<HTMLOListElement>(null);
  const active = flows.findIndex((f) => f.status === "walking" || f.status === "repairing");

  // Follows the flow being walked. The list is taller than its box for a full plan, and the
  // one row worth watching is the one the browser beside it is showing.
  useEffect(() => {
    const el = list.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <ol ref={list} className="max-h-[19rem] min-h-0 flex-1 overflow-y-auto">
      {flows.map((f) => {
        const s = STATUS[f.status];
        return (
          <li key={f.id} className="flex items-start gap-2.5 border-b border-line px-3 py-2 last:border-0">
            <Icon name={s.icon} size={12} className={`mt-1 shrink-0 ${s.tone} ${f.status === "walking" ? "animate-pulse" : ""}`} />
            <span className="min-w-0 flex-1">
              {/* Two lines rather than one: a planner title is a sentence, and the column is narrow enough that truncating one loses the flow's subject. */}
              <span className="block line-clamp-2 text-[12.5px] leading-snug text-body">{f.title}</span>
              <span className="block font-mono text-[11px] text-subtle">{f.id}</span>
            </span>
            <span className={`mt-0.5 shrink-0 text-[10.5px] font-medium uppercase tracking-[0.5px] ${s.tone}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * `liveSrc` is passed in rather than subscribed to here, as on the Sources screen: one
 * screencast subscription per page, owned by the page, and a panel that can be rendered
 * with or without a live browser without opening a socket to find out which.
 */
export function PlannerProgress({ progress, liveSrc }: { progress: Progress; liveSrc: string | null }) {
  const elapsed = useElapsed(progress.startedAt);
  const drafting = progress.phase === "drafting";
  const decided = progress.kept + progress.dropped;
  // A run recorded before the planner reported its flow budget replays with maxFlows 0; three
  // is the orchestrator's own default and the right number of rows to promise in that case.
  const budget = progress.maxFlows || 3;

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="flex items-center gap-2 text-[14px] font-medium tracking-[0.2px] text-fg">
        <Icon name="target" size={15} className="text-muted" />
        {drafting ? "AEGIS is writing your test plan" : "AEGIS is validating the plan on your app"}
        <span className="ml-auto font-mono text-[12px] font-normal text-muted">{elapsed}</span>
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        {drafting ? (
          progress.gaps > 0 ? (
            <>Rewriting the plan to close {progress.gaps} coverage {progress.gaps === 1 ? "gap" : "gaps"} the evaluator found on pass {progress.iteration - 1}. This usually takes about a minute.</>
          ) : (
            <>Reading {progress.pages} {progress.pages === 1 ? "page" : "pages"} and {progress.forms} {progress.forms === 1 ? "form" : "forms"} from the crawl to decide which user flows are worth testing. This usually takes about a minute.</>
          )
        ) : (
          <>Every proposed flow is walked on the live app before it is kept, so no test is written against a
          selector that does not exist. {decided} of {progress.flows.length} decided{progress.dropped > 0 && <> · {progress.dropped} dropped as unreachable</>}.</>
        )}
      </p>

      {/* The phases as a rail: two minutes of silence is bearable when you can see which half you are in. */}
      <ol className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px]">
        {[
          { label: "Draft flows", done: !drafting, live: drafting },
          { label: "Validate on the live app", done: false, live: !drafting },
          { label: "Score coverage", done: false, live: false },
        ].map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            {i > 0 && <Icon name="chevronRight" size={11} className="text-subtle" />}
            <span className={`flex items-center gap-1.5 ${s.live ? "text-fg" : s.done ? "text-muted" : "text-subtle"}`}>
              {s.live ? <Spinner size={12} /> : <Icon name={s.done ? "check" : "dashedCircle"} size={11} className={s.done ? "text-pass" : ""} />}
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {/*
        One slot, two answers. Drafting has no percentage to report - the model is inside a
        single call - so it gets an indeterminate sweep; the dry walk counts real flows and
        gets a real meter. Sharing the slot keeps the panel from jumping when the phase turns.
      */}
      <div className="mt-3.5">
        {drafting ? (
          <Sweep label={`Writing up to ${budget} ${budget === 1 ? "flow" : "flows"}…`} />
        ) : progress.flows.length > 0 ? (
          <Meter value={decided} max={progress.flows.length} label={`Flows validated ${decided}/${progress.flows.length}`} showPercent={false} />
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
        {drafting ? <Routes routes={progress.routes} /> : <LiveViewport src={liveSrc} action={progress.action} />}
        <div className="flex min-h-[16rem] flex-col rounded-box border border-line bg-inset">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Proposed flows</h3>
            <span className="font-mono text-[11px] text-subtle">{progress.flows.length ? progress.flows.length : `0/${budget}`}</span>
          </div>
          {progress.flows.length > 0 ? (
            <FlowList flows={progress.flows} />
          ) : (
            <>
              <FlowSkeleton count={budget} />
              <p className="border-t border-line px-3 py-2.5 text-center text-[12px] leading-relaxed text-subtle">
                The flows appear here the moment the planner has written them.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
