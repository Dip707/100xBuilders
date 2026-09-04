export function Segmented<T extends string>({
  options, value, onChange,
}: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex w-full gap-1 rounded-input bg-inset p-1">
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={o.value === value}
          className={`flex-1 rounded-[0.375rem] px-3 py-1.5 text-sm font-medium transition-colors ${
            o.value === value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
