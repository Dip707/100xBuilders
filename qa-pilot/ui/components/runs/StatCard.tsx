/**
 * The overview metrics, as one hairline-divided strip rather than four floating boxes.
 * The system builds structure from dividers, not from repeated card chrome, and four
 * separate bordered tiles for four numbers is exactly the padding-heavy look it avoids.
 */
export function MetricStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid divide-y divide-line overflow-hidden rounded-card border border-line bg-surface sm:grid-cols-2 xl:grid-cols-4 xl:divide-y-0">
      {children}
    </div>
  );
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-line px-5 py-4 sm:odd:border-r xl:border-l xl:border-r-0 xl:first:border-l-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">{label}</p>
      <p className="mt-1.5 text-[28px] font-medium leading-none tabular-nums tracking-[-0.4px] text-fg">{value}</p>
      <p className="mt-1.5 h-4 text-[12px] text-muted">{hint ?? ""}</p>
    </div>
  );
}
