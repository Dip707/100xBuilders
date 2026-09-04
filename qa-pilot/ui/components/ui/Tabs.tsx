/** The pill-tab strip: the active chip lifts by one surface notch, never by a colour. */
export function Tabs<T extends string>({
  tabs, active, onChange,
}: { tabs: Array<{ id: T; label: string; badge?: number }>; active: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="inline-flex gap-0.5 rounded-input border border-line bg-app p-0.5">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={t.id === active} onClick={() => onChange(t.id)}
          className={`rounded-chip px-2.5 py-1 text-[13px] font-medium tracking-[0.2px] transition-colors ${
            t.id === active ? "bg-inset text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && <span className="ml-1.5 font-mono text-[11px] opacity-60">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
