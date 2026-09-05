import { siJira, siLinear } from "simple-icons";

/*
 * The trackers' own marks, from simple-icons, drawn in their brand colour by default. The
 * system keeps saturated hue off its chrome, but a logo is the one place a brand colour is
 * the honest choice: it is what makes "Connect Linear" read as Linear at a glance.
 */
const MARKS = { linear: siLinear, jira: siJira } as const;

export type TrackerLogoName = keyof typeof MARKS;

export function TrackerLogo({ name, size = 14, mono = false, className = "" }: { name: TrackerLogoName; size?: number; mono?: boolean; className?: string }) {
  const mark = MARKS[name];
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={mark.title} className={`shrink-0 ${className}`}
      fill={mono ? "currentColor" : `#${mark.hex}`}
    >
      <path d={mark.path} />
    </svg>
  );
}
