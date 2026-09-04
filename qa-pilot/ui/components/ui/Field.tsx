export function Field({
  label, required = false, help, children,
}: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-4 md:grid-cols-[minmax(9rem,13rem)_1fr] md:gap-8">
      <label className="pt-1.5 text-sm font-medium tracking-[0.2px] text-fg">
        {label}
        {required && <span className="ml-1 text-fail" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      <div className="space-y-2">
        {children}
        {help && <p className="text-[12px] leading-relaxed text-muted">{help}</p>}
      </div>
    </div>
  );
}
