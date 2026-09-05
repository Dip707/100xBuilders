"use client";
import { useEffect, useRef, useState } from "react";
import { Icon, Meter } from "@/components/ui";
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

/** The routes the crawl found, listed while the planner reads them and there is nothing else to show. */
function Routes({ routes }: { routes: string[] }) {
  return (
    <div className="rounded-box border border-line bg-inset p-3">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Reading</h3>
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {routes.map((r) => (
          <li key={r} className="rounded-chip border border-line bg-surface px-2 py-1 font-mono text-[11.5px] text-body">{r}</li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Each page, form and gated route goes to the planner in one pass, so it can write flows that cross
        between them rather than one page at a time.
      </p>
    </div>
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
              <Icon
                name={s.done ? "check" : "dashedCircle"} size={11}
                className={s.done ? "text-pass" : s.live ? "animate-spin [animation-duration:2.4s]" : ""}
              />
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {!drafting && progress.flows.length > 0 && (
        <div className="mt-3.5">
          <Meter value={decided} max={progress.flows.length} label={`Flows validated ${decided}/${progress.flows.length}`} showPercent={false} />
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
        {drafting ? <Routes routes={progress.routes} /> : <LiveViewport src={liveSrc} action={progress.action} />}
        <div className="flex min-h-[16rem] flex-col rounded-box border border-line bg-inset">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Proposed flows</h3>
            <span className="font-mono text-[11px] text-subtle">{progress.flows.length || "-"}</span>
          </div>
          {progress.flows.length > 0 ? (
            <FlowList flows={progress.flows} />
          ) : (
            <p className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] leading-relaxed text-subtle">
              The flows appear here the moment the planner has written them.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
