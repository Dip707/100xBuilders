const STYLES: Record<string, { label: string; icon: string; className: string }> = {
  // run status
  running:     { label: "running",     icon: "◌", className: "bg-accent-tint text-accent" },
  done:        { label: "done",        icon: "✓", className: "bg-accent-tint text-accent" },
  partial:     { label: "partial",     icon: "◑", className: "bg-inset text-flaky" },
  failed:      { label: "failed",      icon: "✕", className: "bg-inset text-fail" },
  interrupted: { label: "interrupted", icon: "⦸", className: "bg-inset text-env" },
  // test outcome
  passed:      { label: "passed",      icon: "✓", className: "bg-inset text-pass" },
  timedOut:    { label: "timed out",   icon: "✕", className: "bg-inset text-fail" },
  skipped:     { label: "skipped",     icon: "–", className: "bg-inset text-env" },
  // classification
  script:      { label: "script",      icon: "✎", className: "bg-inset text-pass" },
  defect:      { label: "defect",      icon: "●", className: "bg-inset text-defect" },
  flaky:       { label: "flaky",       icon: "⚠", className: "bg-inset text-flaky" },
  env:         { label: "env",         icon: "⌁", className: "bg-inset text-env" },
  needs_human: { label: "needs human", icon: "☝", className: "bg-inset text-human" },
};

/**
 * Every status carries an icon and a word, never a bare colour. Brand green and "passed"
 * green are close by design, so hue is not allowed to be the only signal.
 */
export function StatusPill({ status, suffix }: { status: string; suffix?: string }) {
  const style = STYLES[status] ?? { label: status, icon: "•", className: "bg-inset text-muted" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}>
      <span aria-hidden="true">{style.icon}</span>
      {style.label}
      {suffix && <span className="text-muted">{suffix}</span>}
    </span>
  );
}
