const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 1000], ["minute", 60_000], ["hour", 3_600_000], ["day", 86_400_000],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 minutes ago". Falls back to a date once a run is more than a week old. */
export function relativeTime(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "unknown";
  if (delta > 7 * 86_400_000) return new Date(iso).toLocaleDateString();
  let chosen: [Intl.RelativeTimeFormatUnit, number] = UNITS[0];
  for (const unit of UNITS) if (delta >= unit[1]) chosen = unit;
  return rtf.format(-Math.round(delta / chosen[1]), chosen[0]);
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes === 0 ? `${totalSeconds}s` : `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

/** The target's host and port, for a table cell that must stay narrow. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
