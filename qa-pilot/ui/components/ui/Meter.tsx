/**
 * A hairline progress track. Fills in `fill`, defaulting to the foreground ink.
 * `showPercent` is opt-out for callers whose label already is the number - a coverage row
 * reading "Coverage 0.78 ... 78%" says the same thing twice.
 */
export function Meter({
  value, max = 1, label, fill = "bg-fg", showPercent = true,
}: { value: number; max?: number; label?: string; fill?: string; showPercent?: boolean }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex justify-between text-[11px] tracking-[0.4px] text-muted">
          <span>{label}</span>{showPercent && <span className="tabular-nums">{Math.round(pct)}%</span>}
        </div>
      )}
      <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
