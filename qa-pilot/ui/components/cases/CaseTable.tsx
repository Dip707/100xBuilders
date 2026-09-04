"use client";
import { useState } from "react";
import { StatusPill } from "@/components/ui";
import { PriorityTag } from "./PriorityTag";
import { relativeTime } from "@/lib/format";
import { groupByUseCase, CATEGORY_LABEL, type CaseRow } from "@/lib/cases";

/**
 * The reference's test table: rows grouped under a collapsible use-case header with a
 * count, an id column, the latest status with how long ago it changed, the name, and the
 * priority on the right. `mode` only changes the column headings: Test Cases talks about
 * a test's latest status, Test Runs about its status in this execution.
 */
export function CaseTable({
  rows, allRows, selected, onSelect, mode = "cases", onViewCoverage, emptyLabel = "No test cases yet.",
}: {
  rows: CaseRow[];
  /** Every row before filtering, so a use case with no visible tests still gets a header. */
  allRows?: CaseRow[];
  selected?: string | null;
  onSelect: (id: string) => void;
  mode?: "cases" | "run";
  onViewCoverage?: (useCase: string) => void;
  emptyLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visible = new Map(rows.map((r) => [r.id, r]));
  const groups = groupByUseCase(allRows ?? rows).map((g) => ({ useCase: g.useCase, total: g.rows.length, rows: g.rows.filter((r) => visible.has(r.id)) }));
  const toggle = (useCase: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(useCase)) next.delete(useCase); else next.add(useCase); return next; });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="w-28 px-4 py-2.5 font-medium">{mode === "cases" ? "ID" : "Run status"}</th>
            <th className="w-48 px-2 py-2.5 font-medium">{mode === "cases" ? "Latest status" : "Test"}</th>
            <th className="px-2 py-2.5 font-medium">{mode === "cases" ? "Test name" : ""}</th>
            <th className="w-28 px-4 py-2.5 text-right font-medium">Priority</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-muted">{emptyLabel}</td></tr>
          )}
          {groups.map((g) => {
            const open = !collapsed.has(g.useCase);
            return [
              <tr key={`${g.useCase}-head`} className="bg-inset/70">
                <td colSpan={3} className="px-3 py-2.5">
                  <button onClick={() => toggle(g.useCase)} aria-expanded={open} className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                    <span className={`inline-block text-subtle transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">›</span>
                    {g.useCase}
                    <span className="text-[13px] font-normal text-muted">{g.total}</span>
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {onViewCoverage && (
                    <button onClick={() => onViewCoverage(g.useCase)} className="whitespace-nowrap text-[13px] font-medium text-accent hover:underline">
                      <span aria-hidden="true">⇢</span> View coverage
                    </button>
                  )}
                </td>
              </tr>,
              ...(open
                ? g.rows.length === 0
                  ? [<tr key={`${g.useCase}-empty`}><td colSpan={4} className="px-6 py-4 text-[13px] text-muted">{emptyLabel}</td></tr>]
                  : g.rows.map((r) => (
                    <tr
                      key={r.id} onClick={() => onSelect(r.id)} aria-selected={selected === r.id}
                      className={`cursor-pointer border-b border-line transition-colors last:border-b-0 ${selected === r.id ? "bg-accent-tint/60" : "hover:bg-inset"}`}
                    >
                      {mode === "cases" ? (
                        <>
                          <td className="px-4 py-3 font-mono text-[13px] text-muted">{r.id}</td>
                          <td className="px-2 py-3">
                            <span className="flex items-center gap-2 whitespace-nowrap">
                              <StatusPill status={r.status} />
                              {r.at && <span className="text-[12px] text-subtle">· {relativeTime(r.at)}</span>}
                            </span>
                          </td>
                          <td className="px-2 py-3">
                            <span className="block text-[15px] text-fg">{r.flow.title}</span>
                            <span className="text-[12px] text-subtle">{CATEGORY_LABEL[r.flow.category]}{r.blockedReason ? ` · ${r.blockedReason}` : ""}</span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                          <td colSpan={2} className="px-2 py-3">
                            <span className="block text-[15px] text-fg">{r.flow.title}</span>
                            <span className="font-mono text-[12px] text-subtle">{r.id}{r.blockedReason ? ` · ${r.blockedReason}` : ""}</span>
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right"><PriorityTag priority={r.flow.priority} /></td>
                    </tr>
                  ))
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
