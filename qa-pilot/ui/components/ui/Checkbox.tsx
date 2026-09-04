export function Checkbox({
  checked, onChange, label, help,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex cursor-pointer gap-3">
      <input
        type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-[4px] border-line-strong bg-inset accent-accent"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium tracking-[0.2px] text-fg">{label}</span>
        {help && <span className="block text-[13px] leading-relaxed text-muted">{help}</span>}
      </span>
    </label>
  );
}
