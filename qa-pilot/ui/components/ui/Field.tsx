export function Field({
  label, required = false, help, children,
}: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-5 md:grid-cols-[minmax(9rem,14rem)_1fr] md:gap-8">
      <label className="pt-2 text-[15px] font-semibold text-fg">
        {label}
        {required && <span className="ml-1 text-fail" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      <div className="space-y-1.5">
        {children}
        {help && <p className="text-[13px] leading-relaxed text-muted">{help}</p>}
      </div>
    </div>
  );
}
