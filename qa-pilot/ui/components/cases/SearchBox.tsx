export function SearchBox({ value, onChange, placeholder = "Search tests" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex h-9 w-64 items-center gap-2 rounded-input border border-line-strong bg-surface px-3 text-sm focus-within:border-accent">
      <span className="text-subtle" aria-hidden="true">⌕</span>
      <input
        type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="w-full bg-transparent text-fg placeholder:text-subtle focus:outline-none"
      />
    </label>
  );
}
