"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Icon, Meter, Spinner, Wallpaper } from "@/components/ui";
import { CoverageGraph } from "@/components/coverage/CoverageGraph";
import { PlannerProgress } from "@/components/coverage/PlannerProgress";
import { fileUrl } from "@/lib/api";
import { NextStageCta } from "@/components/stage/NextStageCta";
import { StageWaiting } from "@/components/stage/StageWaiting";
import { useRun } from "@/lib/run-context";
import { useCoverage } from "@/lib/hooks";
import { PLANNER, plannerProgress } from "@/lib/planner";
import { useScreencast } from "@/lib/screencast";

const CHECK_LABEL: Record<string, string> = { forms: "Forms (happy, negative, empty)", authz: "Gated routes", prd: "PRD requirements", intent: "Intent keywords", mix: "Category mix" };

/** The reference's Test Coverage screen: the plan as a graph, with the evaluator's score, checks and open gaps beside it. */
export default function CoveragePage() {
  const { runId, run, error, events, rows, manifest, selectTest, stages } = useRun();
  const stage = stages.find((s) => s.id === "coverage")!;
  const history = useCoverage(runId, events);
  const latest = useMemo(() => (history && history.length ? history[history.length - 1] : null), [history]);
  // The planner writes plan.json only when it is finished, so while it is running this
  // screen has no artifact to draw and shows the work in flight instead.
  const planning = useMemo(() => plannerProgress(events), [events]);
  // One screencast subscription for the screen, open only while the planner has a browser
  // to watch, as on Sources.
  const live = useScreencast(runId, planning !== null);
  const lane = useSearchParams().get("lane");
  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Test coverage" }];

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

  if (stage.status === "not_started" || stage.status === "not_run") {
    return (<><PageHeader crumbs={crumbs} title="Test coverage" /><StageWaiting id="coverage" /></>);
  }

  const planAvailable = manifest?.files.includes("plan.md");
  return (
    <>
      <Wallpaper name="drift" />
      <PageHeader
        crumbs={crumbs} title="Test coverage"
        subtitle="How the planned flows cover what the explorer found, and the gaps the evaluator still sees. Click a test to open it."
        actions={
          <div className="flex items-center gap-2">
            {planAvailable && (
              <a href={fileUrl(runId, "plan.md")} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><Icon name="file" size={13} /> Open plan</Button>
              </a>
            )}
            <Link href="/runs/new"><Button size="sm"><Icon name="sparkles" size={13} /> Plan a new run</Button></Link>
          </div>
        }
      />
      <div className="grid gap-5 px-6 pb-10 pt-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-5">
          {planning && <PlannerProgress progress={planning} liveSrc={live.find((v) => v.agent === PLANNER)?.src ?? null} />}
          {/*
            The graph is held back on a first pass rather than drawn empty: its own "no flows
            yet" plate next to a live progress panel would be two answers to the same
            question. A re-plan keeps it, because the flows already on screen are what the
            planner is rewriting.
          */}
          {(!planning || rows.length > 0) && (
            history === null || run === null ? <div className="flex justify-center py-16"><Spinner size={20} /></div> : (
              <CoverageGraph rows={rows} coverage={latest} onSelect={selectTest} highlight={lane} />
            )
          )}
        </div>
        <aside className="space-y-4 xl:sticky xl:top-[68px] xl:self-start">
          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-[13px] font-medium tracking-[0.2px] text-fg">Coverage score</h2>
            {latest ? (
              <>
                <p className="mt-2.5 text-[34px] font-medium leading-none tabular-nums tracking-[-0.6px] text-fg">
                  {Math.round(latest.score * 100)}<span className="text-[15px] text-subtle">%</span>
                </p>
                <div className="mt-3"><Meter value={latest.score} fill={latest.score >= 0.75 ? "bg-pass" : "bg-flaky"} /></div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                  {latest.score >= 0.75 ? "Passed the 0.75 gate" : "Below the 0.75 gate"} after {history?.length ?? 1} {history && history.length === 1 ? "iteration" : "iterations"}.
                </p>
                <dl className="mt-4 space-y-2.5 border-t border-line pt-3.5">
                  {Object.entries(latest.checks).map(([k, v]) => (
                    <div key={k}>
                      <div className="flex justify-between text-[11.5px]">
                        <dt className="text-muted">{CHECK_LABEL[k] ?? k}</dt>
                        <dd className="font-mono tabular-nums text-fg">{Math.round(v * 100)}%</dd>
                      </div>
                      <div className="mt-1"><Meter value={v} /></div>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-muted">
                {planning ? "The evaluator scores the plan as soon as the planner has written it." : "The evaluator has not scored a plan yet."}
              </p>
            )}
          </section>

          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-[13px] font-medium tracking-[0.2px] text-fg">
              Open gaps <span className="font-mono font-normal text-muted">{latest?.gaps.length ?? 0}</span>
            </h2>
            {latest && latest.gaps.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {latest.gaps.map((g, i) => (
                  <li key={i} className="rounded-box border border-dashed border-flaky/40 bg-flaky/[0.07] px-3 py-2 text-[11.5px] leading-relaxed">
                    <p className="font-medium text-flaky">{g.kind.replace(/_/g, " ")} {g.target ?? g.requirement ?? ""}</p>
                    <p className="text-body">{g.suggest}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">
                {latest ? "No gaps remain against the explored app." : "Gaps appear once the evaluator has scored the plan."}
              </p>
            )}
          </section>

          {latest && latest.untested_risk.length > 0 && (
            <section className="rounded-card border border-line bg-surface p-4">
              <h2 className="text-[13px] font-medium tracking-[0.2px] text-fg">Untested risk</h2>
              <ul className="mt-3 space-y-2 text-[11.5px] leading-relaxed">
                {latest.untested_risk.map((r, i) => (
                  <li key={i}><span className="font-mono text-fg">{r.flow}</span> <span className="text-muted">({r.risk}) {r.reason}</span></li>
                ))}
              </ul>
            </section>
          )}

          {latest && latest.prdRequirements.length > 0 && (
            <section className="rounded-card border border-line bg-surface p-4">
              <h2 className="text-[13px] font-medium tracking-[0.2px] text-fg">PRD requirements</h2>
              <ul className="mt-3 space-y-2 text-[11.5px] leading-relaxed">
                {latest.prdRequirements.map((r) => {
                  const flows = latest.prdMatrix[r] ?? [];
                  return (
                    <li key={r} className="flex gap-2">
                      <Icon name={flows.length ? "check" : "halfCircle"} size={12} className={`mt-0.5 ${flows.length ? "text-pass" : "text-flaky"}`} />
                      <span className="min-w-0">
                        <span className="text-body">{r}</span>{" "}
                        <span className="font-mono text-subtle">{flows.join(", ") || "uncovered"}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

        </aside>
      </div>
      <div className="px-6 pb-10">
        <NextStageCta from="coverage" />
      </div>
    </>
  );
}
