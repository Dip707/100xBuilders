"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Meter, Spinner } from "@/components/ui";
import { CoverageGraph } from "@/components/coverage/CoverageGraph";
import { fileUrl } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { useCoverage } from "@/lib/hooks";

const CHECK_LABEL: Record<string, string> = { forms: "Forms (happy, negative, empty)", authz: "Gated routes", prd: "PRD requirements", intent: "Intent keywords", mix: "Category mix" };

/** The reference's Test Coverage screen: the plan as a graph, with the evaluator's score, checks and open gaps beside it. */
export default function CoveragePage() {
  const { runId, run, error, events, rows, manifest, selectTest } = useRun();
  const history = useCoverage(runId, events);
  const latest = useMemo(() => (history && history.length ? history[history.length - 1] : null), [history]);
  const lane = useSearchParams().get("lane");
  const crumbs = [{ label: "Runs", href: "/" }, { label: runId, href: `/runs/${encodeURIComponent(runId)}` }, { label: "Test coverage" }];

  if (error) return (<><PageHeader crumbs={crumbs} /><p role="alert" className="m-8 rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p></>);

  const planAvailable = manifest?.files.includes("plan.md");
  return (
    <>
      <PageHeader
        crumbs={crumbs} title="Test coverage"
        subtitle="How the planned flows cover what the explorer found, and the gaps the evaluator still sees. Click a test to open it."
        actions={
          <div className="flex items-center gap-2">
            {planAvailable && <a href={fileUrl(runId, "plan.md")} target="_blank" rel="noreferrer"><Button variant="outline" size="sm">Open plan</Button></a>}
            <Link href="/runs/new"><Button size="sm">✦ Plan a new run</Button></Link>
          </div>
        }
      />
      <div className="grid gap-6 px-8 pb-10 pt-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        {history === null || run === null ? <div className="flex justify-center py-16"><Spinner size={22} /></div> : (
          <CoverageGraph rows={rows} coverage={latest} onSelect={selectTest} highlight={lane} />
        )}
        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <section className="rounded-card border border-line bg-surface p-5">
            <h2 className="text-[15px] font-semibold text-fg">Coverage score</h2>
            {latest ? (
              <>
                <p className="mt-2 text-[32px] font-semibold leading-none text-fg">{Math.round(latest.score * 100)}<span className="text-[16px] text-muted">%</span></p>
                <div className="mt-3"><Meter value={latest.score} /></div>
                <p className="mt-2 text-[12px] text-muted">{latest.score >= 0.75 ? "Passed the 0.75 gate" : "Below the 0.75 gate"} after {history?.length ?? 1} {history && history.length === 1 ? "iteration" : "iterations"}.</p>
                <dl className="mt-4 space-y-2.5">
                  {Object.entries(latest.checks).map(([k, v]) => (
                    <div key={k}>
                      <div className="flex justify-between text-[12px]"><dt className="text-muted">{CHECK_LABEL[k] ?? k}</dt><dd className="font-medium text-fg">{Math.round(v * 100)}%</dd></div>
                      <Meter value={v} />
                    </div>
                  ))}
                </dl>
              </>
            ) : <p className="mt-2 text-sm text-muted">The evaluator has not scored a plan yet.</p>}
          </section>

          <section className="rounded-card border border-line bg-surface p-5">
            <h2 className="text-[15px] font-semibold text-fg">Open gaps <span className="font-normal text-muted">{latest?.gaps.length ?? 0}</span></h2>
            {latest && latest.gaps.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {latest.gaps.map((g, i) => (
                  <li key={i} className="rounded-box border border-dashed border-flaky/60 bg-flaky/5 px-3 py-2 text-[12px] leading-relaxed">
                    <p className="font-medium text-flaky">{g.kind.replace(/_/g, " ")} {g.target ?? g.requirement ?? ""}</p>
                    <p className="text-fg">{g.suggest}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-sm text-muted">No gaps remain against the explored app.</p>}
          </section>

          {latest && latest.untested_risk.length > 0 && (
            <section className="rounded-card border border-line bg-surface p-5">
              <h2 className="text-[15px] font-semibold text-fg">Untested risk</h2>
              <ul className="mt-3 space-y-2 text-[12px]">
                {latest.untested_risk.map((r, i) => <li key={i}><span className="font-mono text-fg">{r.flow}</span> <span className="text-muted">({r.risk}) {r.reason}</span></li>)}
              </ul>
            </section>
          )}

          {latest && latest.prdRequirements.length > 0 && (
            <section className="rounded-card border border-line bg-surface p-5">
              <h2 className="text-[15px] font-semibold text-fg">PRD requirements</h2>
              <ul className="mt-3 space-y-2 text-[12px]">
                {latest.prdRequirements.map((r) => {
                  const flows = latest.prdMatrix[r] ?? [];
                  return <li key={r}><span className={flows.length ? "text-pass" : "text-flaky"}>{flows.length ? "✓" : "◑"}</span> <span className="text-fg">{r}</span> <span className="font-mono text-subtle">{flows.join(", ") || "uncovered"}</span></li>;
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
