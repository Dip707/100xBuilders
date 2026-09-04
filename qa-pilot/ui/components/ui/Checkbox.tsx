export function Checkbox({
  checked, onChange, label, help,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex cursor-pointer gap-3">
      <input
        type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-[18px] shrink-0 cursor-pointer rounded-[4px] border-line-strong accent-accent"
      />
      <span className="space-y-1">
        <span className="block text-[15px] font-semibold text-fg">{label}</span>
        {help && <span className="block text-[13px] leading-relaxed text-muted">{help}</span>}
      </span>
    </label>
  );
}
