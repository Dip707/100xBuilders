/** The reference's thin green progress bar. `value` and `max` are in the caller's own units. */
export function Meter({ value, max = 1, label }: { value: number; max?: number; label?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="space-y-1">
      {label && <div className="flex justify-between text-xs text-muted"><span>{label}</span><span>{Math.round(pct)}%</span></div>}
      <div className="h-1.5 overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
