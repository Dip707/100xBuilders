import { Icon } from "@/components/ui";

export function SearchBox({ value, onChange, placeholder = "Search tests" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex h-8 w-60 items-center gap-2 rounded-input border border-line bg-inset px-2.5 text-[13px] focus-within:border-line-strong">
      <Icon name="search" size={14} className="text-subtle" />
      <input
        type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="w-full bg-transparent text-fg placeholder:text-subtle focus:outline-none"
      />
    </label>
  );
}
