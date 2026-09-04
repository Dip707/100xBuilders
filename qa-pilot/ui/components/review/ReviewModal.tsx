"use client";
import { useMemo, useState } from "react";
import { Button, Spinner } from "@/components/ui";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div className="flex max-h-full w-full max-w-[1180px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-2xl">
        <header className="border-b border-line px-7 py-5">
          <h2 id="review-title" className="text-[22px] font-semibold text-fg">Review proposed tests</h2>
          <p className="mt-1 text-[15px] text-muted">
            {flows.length} tests proposed across {groups.length} use {groups.length === 1 ? "case" : "cases"}. Review, edit, and select which to generate. Nothing is generated until you confirm.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)]">
          <nav className="overflow-auto border-r border-line p-3" aria-label="Use cases">
            <button onClick={() => setUseCase(null)} className={`flex w-full items-center justify-between rounded-box px-3 py-2.5 text-[15px] ${useCase === null ? "bg-inset font-medium text-fg" : "text-fg hover:bg-inset"}`}>
              All use cases <span className="text-[13px] text-muted">{flows.length}</span>
            </button>
            {groups.map((g) => (
              <button key={g.name} onClick={() => setUseCase(g.name)} className={`flex w-full items-center justify-between rounded-box px-3 py-2.5 text-[15px] ${useCase === g.name ? "bg-inset font-medium text-fg" : "text-fg hover:bg-inset"}`}>
                {g.name} <span className="text-[13px] text-muted">{g.flows.filter((f) => !deselected.has(f.id)).length}/{g.flows.length}</span>
              </button>
            ))}
          </nav>

          <div className="overflow-auto p-5">
            {flows.length === 0 ? <div className="flex justify-center p-10"><Spinner size={22} /></div> : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium uppercase tracking-wide text-muted">
                    <th className="w-10 px-2 py-2"><input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown" className="size-4 accent-accent" /></th>
                    <th className="w-10 px-2 py-2 font-medium">No.</th>
                    <th className="w-36 px-2 py-2 font-medium">Priority</th>
                    <th className="w-[30%] px-2 py-2 font-medium">Test name</th>
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
                        <td className="px-2 py-3"><input type="checkbox" checked={on} onChange={() => toggle(f.id)} aria-label={`Include ${f.title}`} className="size-4 accent-accent" /></td>
                        <td className="px-2 py-3 text-muted">{i + 1}</td>
                        <td className="px-2 py-2">
                          <select value={f.priority} onChange={(e) => edit(raw, { priority: e.target.value as Priority })} aria-label="Priority" className="h-9 w-full rounded-input border border-line-strong bg-surface px-2 text-sm text-fg">
                            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <textarea value={f.title} onChange={(e) => edit(raw, { title: e.target.value })} rows={3} aria-label="Test name" className="w-full resize-none rounded-input border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none" />
                          <button onClick={() => flip(f.id)} aria-expanded={open} className="mt-1 text-[12px] font-medium text-muted hover:text-fg">{open ? "▾ Hide flow" : "▸ Show flow"}</button>
                        </td>
                        <td className="px-2 py-2">
                          <p className="rounded-input border border-line bg-inset/60 px-2 py-1.5 text-[13px] leading-relaxed text-fg">{describeFlow(f)}</p>
                          <p className="mt-1 font-mono text-[11px] text-subtle">{f.id}</p>
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${f.id}-flow`}>
                          <td colSpan={2} />
                          <td colSpan={3} className="px-2 pb-4">
                            <ol className="space-y-1.5 rounded-box border border-line bg-inset/40 p-3">
                              {f.preconditions.includes("logged_in") && <li className="flex gap-3 text-[13px]"><span className="w-5 text-right text-subtle">0.</span><span className="flex-1 rounded-input bg-surface px-2 py-1.5 text-fg">Sign in with the provided credentials</span></li>}
                              {f.steps.map((s, j) => <li key={j} className="flex gap-3 text-[13px]"><span className="w-5 text-right text-subtle">{j + 1}.</span><span className="flex-1 rounded-input bg-surface px-2 py-1.5 text-fg">{stepLabel(s)}</span></li>)}
                              {f.expected.map((e, j) => <li key={`e${j}`} className="flex gap-3 text-[13px]"><span className="w-5 text-right text-subtle">{f.steps.length + j + 1}.</span><span className="flex-1 rounded-input bg-surface px-2 py-1.5 text-accent">{expectationLabel(e)}</span></li>)}
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

        <footer className="flex items-center justify-between gap-4 border-t border-line px-7 py-4">
          <p className="text-[13px] text-muted">{selectedCount} of {flows.length} selected. Deselected flows are dropped from this run; the report lists them as untested.</p>
          <div className="flex items-center gap-3">
            {error && <p role="alert" className="text-sm text-fail">{error}</p>}
            <Button onClick={confirm} disabled={busy || flows.length === 0}>{busy ? <><Spinner /> Starting</> : `▷ Run ${selectedCount === flows.length ? "all" : selectedCount}`}</Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
