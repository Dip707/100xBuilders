/**
 * Marks a field the assistant just wrote. A box-shadow ring rather than a border or an
 * outline, so nothing reflows when it appears and nothing shifts when it fades: the field
 * simply glows for a moment and settles.
 */
export function Flash({ on, children, className = "" }: { on: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-input transition-shadow duration-700 ${on ? "shadow-[0_0_0_2px_var(--color-info)]" : "shadow-none"} ${className}`}
    >
      {children}
    </div>
  );
}
