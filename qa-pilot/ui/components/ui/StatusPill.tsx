import { Icon, type IconName } from "./Icon";

type Style = { label: string; icon: IconName; className: string; spin?: boolean };

/*
 * Raycast keeps saturated colour off its chrome, but a test dashboard is exactly the case
 * the accents exist for: a status is data, not decoration. Each pill is a soft 15%-alpha
 * wash of its hue with the saturated hue as text, which is the `badge-info-soft` recipe
 * applied across the four accents.
 */
const STYLES: Record<string, Style> = {
  // run status
  running:         { label: "running",         icon: "dashedCircle", className: "bg-info/12 text-info", spin: true },
  awaiting_review: { label: "awaiting review", icon: "clipboard",    className: "bg-human/12 text-human" },
  done:            { label: "done",            icon: "check",        className: "bg-pass/12 text-pass" },
  partial:         { label: "partial",         icon: "halfCircle",   className: "bg-flaky/12 text-flaky" },
  failed:          { label: "failed",          icon: "x",            className: "bg-fail/12 text-fail" },
  interrupted:     { label: "interrupted",     icon: "ban",          className: "bg-inset text-env" },
  // test case status
  planned:         { label: "planned",         icon: "dashedCircle", className: "bg-inset text-muted" },
  blocked:         { label: "blocked",         icon: "halfCircle",   className: "bg-flaky/12 text-flaky" },
  // test outcome
  passed:          { label: "passed",          icon: "check",        className: "bg-pass/12 text-pass" },
  timedOut:        { label: "timed out",       icon: "clock",        className: "bg-fail/12 text-fail" },
  skipped:         { label: "skipped",         icon: "minus",        className: "bg-inset text-env" },
  // classification
  script:          { label: "script",          icon: "pen",          className: "bg-inset text-body" },
  healed:          { label: "healed",          icon: "wand",         className: "bg-pass/12 text-pass" },
  defect:          { label: "defect",          icon: "bug",          className: "bg-defect/12 text-defect" },
  flaky:           { label: "flaky",           icon: "alert",        className: "bg-flaky/12 text-flaky" },
  env:             { label: "env",             icon: "bolt",         className: "bg-inset text-env" },
  needs_human:     { label: "needs human",     icon: "hand",         className: "bg-human/12 text-human" },
};

/**
 * Every status carries an icon and a word, never a bare colour. Two of the accents sit
 * close in hue, so hue is never allowed to be the only signal.
 */
export function StatusPill({ status, suffix }: { status: string; suffix?: string }) {
  const style = STYLES[status] ?? { label: status, icon: "dot" as const, className: "bg-inset text-muted" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip px-2 py-1 text-[12px] font-medium leading-none tracking-[0.2px] ${style.className}`}>
      <Icon name={style.icon} size={12} className={style.spin ? "animate-spin [animation-duration:2.4s]" : ""} />
      {style.label}
      {suffix && <span className="font-mono opacity-60">{suffix}</span>}
    </span>
  );
}
