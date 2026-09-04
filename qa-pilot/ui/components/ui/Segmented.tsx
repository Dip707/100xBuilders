export function Segmented<T extends string>({
  options, value, onChange,
}: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-input border border-line bg-app p-0.5">
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={o.value === value}
          className={`rounded-chip px-3 py-1 text-[13px] font-medium tracking-[0.2px] transition-colors ${
            o.value === value ? "bg-inset text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
