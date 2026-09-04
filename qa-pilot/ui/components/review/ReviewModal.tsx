"use client";
import { useMemo, useState } from "react";
import { Button, Icon, Spinner } from "@/components/ui";
import { submitReview } from "@/lib/api";
import { useRun } from "@/lib/run-context";
import { describeFlow, expectationLabel, stepLabel, areaOf, PRIORITY_LABEL, PRIORITY_ORDER, type Flow, type Priority } from "@/lib/cases";

/**
 * The reference's "Review proposed tests" sheet. Shown while the run is parked at the
 * review gate: every proposed flow can be renamed, re-prioritised or deselected, and
 * nothing is generated until the reviewer confirms. Flows are edited as local drafts; the
 * submitted plan is what the generator sees, and plan.json is rewritten to match.
 */
export function ReviewModal() {
  const { runId, plan } = useRun();
  const flows = useMemo(() => plan ?? [], [plan]);
  const [drafts, setDrafts] = useState<Record<string, Flow>>({});
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [useCase, setUseCase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = (f: Flow): Flow => drafts[f.id] ?? f;
  const groups = useMemo(() => {
    const m = new Map<string, Flow[]>();
    for (const f of flows) m.set(areaOf(f.id), [...(m.get(areaOf(f.id)) ?? []), f]);
    return [...m].map(([name, list]) => ({ name, flows: list }));
  }, [flows]);
  const shown = useCase ? flows.filter((f) => areaOf(f.id) === useCase) : flows;
  const selectedCount = flows.length - deselected.size;
  const allShownSelected = shown.every((f) => !deselected.has(f.id));

  const toggleAll = () => setDeselected((prev) => {
    const next = new Set(prev);
    for (const f of shown) { if (allShownSelected) next.add(f.id); else next.delete(f.id); }
    return next;
  });
  const toggle = (id: string) => setDeselected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const edit = (f: Flow, patch: Partial<Flow>) => setDrafts((prev) => ({ ...prev, [f.id]: { ...current(f), ...patch } }));
  const flip = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await submitReview(runId, flows.filter((f) => !deselected.has(f.id)).map(current));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div className="animate-palette-in flex max-h-full w-full max-w-[1180px] flex-col overflow-hidden rounded-card border border-line bg-surface">
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-box border border-line bg-inset text-human">
            <Icon name="clipboard" size={16} />
          </span>
          <div>
            <h2 id="review-title" className="text-[17px] font-medium tracking-[0.2px] text-fg">Review proposed tests</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              {flows.length} tests proposed across {groups.length} use {groups.length === 1 ? "case" : "cases"}. Review, edit, and select which to generate. Nothing is generated until you confirm.
            </p>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)]">
          <nav className="space-y-px overflow-auto border-r border-line bg-app p-2" aria-label="Use cases">
            <button onClick={() => setUseCase(null)} className={`flex w-full items-center justify-between gap-2 rounded-input px-2.5 py-2 text-[13.5px] transition-colors ${useCase === null ? "bg-selected font-medium text-fg" : "text-muted hover:bg-selected hover:text-fg"}`}>
              All use cases <span className="font-mono text-[12px] text-subtle">{flows.length}</span>
            </button>
            {groups.map((g) => (
              <button key={g.name} onClick={() => setUseCase(g.name)} className={`flex w-full items-center justify-between gap-2 rounded-input px-2.5 py-2 text-left text-[13.5px] transition-colors ${useCase === g.name ? "bg-selected font-medium text-fg" : "text-muted hover:bg-selected hover:text-fg"}`}>
                <span className="truncate">{g.name}</span>
                <span className="shrink-0 font-mono text-[12px] text-subtle">{g.flows.filter((f) => !deselected.has(f.id)).length}/{g.flows.length}</span>
              </button>
            ))}
          </nav>

          {/*
            The columns are percentage-width, so below roughly 1100px they crush the
            priority select and wrap every title to one word per line. A min-width and a
            horizontal scroll is what every other table in the app does.
          */}
          <div className="overflow-auto p-4">
            {flows.length === 0 ? <div className="flex justify-center p-10"><Spinner size={20} /></div> : (
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">
                    <th className="w-10 px-2 py-2"><input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown" className="size-4 rounded-[4px] border-line-strong bg-inset accent-accent" /></th>
                    <th className="w-10 px-2 py-2 font-medium">No.</th>
                    <th className="w-32 min-w-32 px-2 py-2 font-medium">Priority</th>
                    <th className="w-[32%] min-w-56 px-2 py-2 font-medium">Test name</th>
                    <th className="px-2 py-2 font-medium">Test description</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((raw, i) => {
                    const f = current(raw);
                    const on = !deselected.has(f.id);
                    const open = expanded.has(f.id);
                    return [
                      <tr key={f.id} className={`align-top ${on ? "" : "opacity-50"}`}>
                        <td className="px-2 py-3"><input type="checkbox" checked={on} onChange={() => toggle(f.id)} aria-label={`Include ${f.title}`} className="size-4 rounded-[4px] border-line-strong bg-inset accent-accent" /></td>
                        <td className="px-2 py-3 font-mono text-[12.5px] text-subtle">{i + 1}</td>
                        <td className="px-2 py-2">
                          <select value={f.priority} onChange={(e) => edit(raw, { priority: e.target.value as Priority })} aria-label="Priority" className="h-8 w-full rounded-input border border-line bg-inset px-2 text-[13px] text-fg focus:border-line-strong focus:outline-none">
                            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <textarea value={f.title} onChange={(e) => edit(raw, { title: e.target.value })} rows={3} aria-label="Test name" className="w-full resize-none rounded-input border border-line bg-inset px-2 py-1.5 text-[13px] leading-relaxed text-fg focus:border-line-strong focus:outline-none" />
                          <button onClick={() => flip(f.id)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted transition-colors hover:text-fg">
                            <Icon name="chevronRight" size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
                            {open ? "Hide flow" : "Show flow"}
                          </button>
                        </td>
                        <td className="px-2 py-2">
                          <p className="rounded-input border border-line bg-inset px-2 py-1.5 text-[12.5px] leading-relaxed text-body">{describeFlow(f)}</p>
                          <p className="mt-1 font-mono text-[11px] text-subtle">{f.id}</p>
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${f.id}-flow`}>
                          <td colSpan={2} />
                          <td colSpan={3} className="px-2 pb-4">
                            <ol className="space-y-1.5 rounded-box border border-line bg-app p-3">
                              {f.preconditions.includes("logged_in") && <li className="flex gap-3 text-[13px]"><span className="w-5 shrink-0 text-right font-mono text-subtle">0.</span><span className="flex-1 rounded-input border border-line bg-surface px-2 py-1.5 text-body">Sign in with the provided credentials</span></li>}
                              {f.steps.map((s, j) => <li key={j} className="flex gap-3 text-[13px]"><span className="w-5 shrink-0 text-right font-mono text-subtle">{j + 1}.</span><span className="flex-1 rounded-input border border-line bg-surface px-2 py-1.5 text-body">{stepLabel(s)}</span></li>)}
                              {f.expected.map((e, j) => <li key={`e${j}`} className="flex gap-3 text-[13px]"><span className="w-5 shrink-0 text-right font-mono text-subtle">{f.steps.length + j + 1}.</span><span className="flex-1 rounded-input border border-info/25 bg-info/[0.07] px-2 py-1.5 text-info">{expectationLabel(e)}</span></li>)}
                            </ol>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            <span className="font-mono text-fg">{selectedCount}</span> of {flows.length} selected. Deselected flows are dropped from this run; the report lists them as untested.
          </p>
          <div className="flex items-center gap-3">
            {error && <p role="alert" className="flex items-center gap-1.5 text-[13px] text-fail"><Icon name="alert" size={14} /> {error}</p>}
            <Button onClick={confirm} disabled={busy || flows.length === 0}>
              {busy ? <><Spinner /> Starting</> : <><Icon name="play" size={13} /> Run {selectedCount === flows.length ? "all" : selectedCount}</>}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
