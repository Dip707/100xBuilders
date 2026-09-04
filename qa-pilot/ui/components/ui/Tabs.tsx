export function Tabs<T extends string>({
  tabs, active, onChange,
}: { tabs: Array<{ id: T; label: string; badge?: number }>; active: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-full bg-inset p-1">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={t.id === active} onClick={() => onChange(t.id)}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
            t.id === active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && <span className="ml-1.5 text-xs text-subtle">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
