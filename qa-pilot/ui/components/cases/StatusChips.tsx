import { CASE_STATUSES, type CaseStatus } from "@/lib/cases";

const LABEL: Record<CaseStatus | "all", string> = { all: "All", planned: "Planned", running: "Running", passed: "Passed", failed: "Failed", blocked: "Blocked" };
const ICON: Record<CaseStatus | "all", string> = { all: "", planned: "◌", running: "⧗", passed: "✓", failed: "✕", blocked: "◑" };
const TONE: Record<CaseStatus | "all", string> = { all: "text-fg", planned: "text-muted", running: "text-accent", passed: "text-pass", failed: "text-fail", blocked: "text-flaky" };

/** The status filter row above a test table: one chip per status with its count, the active one outlined. */
export function StatusChips({ counts, active, onChange }: { counts: Record<CaseStatus | "all", number>; active: CaseStatus | "all"; onChange: (s: CaseStatus | "all") => void }) {
  const all: Array<CaseStatus | "all"> = ["all", ...CASE_STATUSES];
  return (
    <div role="tablist" aria-label="Filter by status" className="flex flex-wrap items-center gap-1">
      {all.map((s) => (
        <button
          key={s} role="tab" aria-selected={active === s} onClick={() => onChange(s)}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
            active === s ? "border-line-strong bg-surface text-fg shadow-sm" : "border-transparent text-muted hover:bg-inset hover:text-fg"
          }`}
        >
          {ICON[s] && <span className={TONE[s]} aria-hidden="true">{ICON[s]}</span>}
          {LABEL[s]}
          <span className={`rounded-full px-1.5 text-[11px] ${active === s ? "bg-inset text-fg" : "text-subtle"}`}>{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}
