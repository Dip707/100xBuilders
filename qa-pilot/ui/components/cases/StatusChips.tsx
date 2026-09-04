import { Icon, type IconName } from "@/components/ui";
import { CASE_STATUSES, type CaseStatus } from "@/lib/cases";

const LABEL: Record<CaseStatus | "all", string> = { all: "All", planned: "Planned", running: "Running", passed: "Passed", failed: "Failed", blocked: "Blocked" };
const ICON: Record<CaseStatus | "all", IconName | null> = { all: null, planned: "dashedCircle", running: "clock", passed: "check", failed: "x", blocked: "halfCircle" };
const TONE: Record<CaseStatus | "all", string> = { all: "", planned: "text-muted", running: "text-info", passed: "text-pass", failed: "text-fail", blocked: "text-flaky" };

/** The status filter row above a test table: one chip per status with its count, the active one lifted by a surface notch. */
export function StatusChips({ counts, active, onChange }: { counts: Record<CaseStatus | "all", number>; active: CaseStatus | "all"; onChange: (s: CaseStatus | "all") => void }) {
  const all: Array<CaseStatus | "all"> = ["all", ...CASE_STATUSES];
  return (
    <div role="tablist" aria-label="Filter by status" className="flex flex-wrap items-center gap-1">
      {all.map((s) => {
        const icon = ICON[s];
        return (
          <button
            key={s} role="tab" aria-selected={active === s} onClick={() => onChange(s)}
            className={`flex items-center gap-1.5 rounded-chip border px-2.5 py-1.5 text-[12.5px] font-medium tracking-[0.2px] transition-colors ${
              active === s ? "border-line bg-inset text-fg" : "border-transparent text-muted hover:bg-selected hover:text-fg"
            }`}
          >
            {icon && <Icon name={icon} size={12} className={TONE[s]} />}
            {LABEL[s]}
            <span className={`font-mono text-[11px] tabular-nums ${active === s ? "text-muted" : "text-subtle"}`}>{counts[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
