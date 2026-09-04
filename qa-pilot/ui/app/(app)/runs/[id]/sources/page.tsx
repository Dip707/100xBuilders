"use client";
import { useCallback, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Icon, Spinner, Wallpaper } from "@/components/ui";
import { RunHeader } from "@/components/run/RunHeader";
import { Filmstrip } from "@/components/sources/Filmstrip";
import { StepsRail } from "@/components/sources/StepsRail";
import { Viewport } from "@/components/sources/Viewport";
import { NextStageCta } from "@/components/stage/NextStageCta";
import { StageWaiting } from "@/components/stage/StageWaiting";
import { useRun } from "@/lib/run-context";
import { useScreencast } from "@/lib/screencast";
import { exploreFrames, exploreSteps, pagesVisited, EXPLORER } from "@/lib/frames";

/**
 * Sources: what qa-pilot read to understand the app.
 *
 * The first screen of the workspace and the first thing a run has to show, because the
 * crawl is what everything downstream is derived from. While it is live this is the
 * explorer's browser; afterwards it is the recording of that same crawl, with every page
 * it captured in a strip underneath and the agent's own steps beside it.
 */
export default function SourcesPage() {
  const { runId, run, error, events, stages } = useRun();
  const stage = stages.find((s) => s.id === "sources")!;
  const live = useScreencast(runId, stage.status === "active");
  const explorer = live.find((v) => v.agent === EXPLORER) ?? live[0] ?? null;

  const frames = useMemo(() => exploreFrames(events, runId), [events, runId]);
  const steps = useMemo(() => exploreSteps(events, runId), [events, runId]);
  const pages = useMemo(() => pagesVisited(events), [events]);

  const [current, setCurrent] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [tracked, setTracked] = useState(0);
  const seek = useCallback((index: number) => { setPinned(true); setCurrent(index); }, []);

  // Adjusted during render rather than in an effect, as React prescribes for state derived
  // from props: until the user picks a frame, the screen follows the newest one, so a live
  // crawl always shows where the agent has actually got to.
  if (tracked !== frames.length) {
    setTracked(frames.length);
    if (!pinned && frames.length > 0) setCurrent(frames.length);
  }

  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Sources" }];

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
  if (!run) {
    return (<><PageHeader crumbs={crumbs} /><div className="flex justify-center p-16"><Spinner size={20} /></div></>);
  }
  if (stage.status === "not_started" || stage.status === "not_run") {
    return (<><PageHeader crumbs={crumbs} title="Sources" /><StageWaiting id="sources" /></>);
  }

  const exploring = stage.status === "active";
  return (
    <>
      <Wallpaper name="drift" />
      <PageHeader
        crumbs={crumbs} title="Sources"
        subtitle="What qa-pilot read to understand your product. Everything the planner writes is derived from this crawl."
      />
      <RunHeader run={run} />

      <div className="space-y-5 px-6 pb-10 pt-5">
        <section className="rounded-card border border-line bg-surface p-4">
          <h2 className="flex items-center gap-2 text-[14px] font-medium tracking-[0.2px] text-fg">
            <Icon name="compass" size={15} className="text-muted" />
            {exploring ? "qa-pilot is exploring your app" : "Exploration complete"}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {exploring ? (
              <>Browsing <span className="text-body">{run.url}</span> to learn its pages, forms and gated routes. This usually takes a few minutes.</>
            ) : (
              <>Crawled <span className="text-body">{run.url}</span> - {pages} {pages === 1 ? "page" : "pages"} visited, {frames.length} {frames.length === 1 ? "frame" : "frames"} captured. Play the recording to watch it back.</>
            )}
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
            <Viewport
              runId={runId} liveSrc={explorer?.src ?? null} frames={frames}
              current={current} onSeek={seek} playing={playing} onPlayingChange={setPlaying}
            />
            <div className="max-h-[26rem] min-h-[16rem]">
              <StepsRail steps={steps} pages={pages} current={current} onSeek={seek} live={exploring} />
            </div>
          </div>
        </section>

        <Filmstrip frames={frames} runId={runId} current={current} onSeek={seek} />

        <NextStageCta from="sources" />
      </div>
    </>
  );
}
