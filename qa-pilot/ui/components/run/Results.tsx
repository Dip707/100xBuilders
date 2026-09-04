import { testRows, tally } from "@/lib/derive";
import { StatusPill } from "@/components/ui";
import type { RunEvent } from "@/lib/events";

export function Results({ events }: { events: RunEvent[] }) {
  const rows = testRows(events);
  const { passed, failed } = tally(rows);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted">No tests have finished yet.</p>;

  return (
    <div className="h-full overflow-auto p-1">
      <div className="mb-3 flex gap-6 px-1">
        <span className="text-sm"><span className="text-lg font-semibold text-pass">{passed}</span> <span className="text-muted">passed</span></span>
        <span className="text-sm"><span className="text-lg font-semibold text-fail">{failed}</span> <span className="text-muted">failed</span></span>
      </div>
      <ul className="space-y-1">
        {rows.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-box px-1 py-1.5 hover:bg-inset">
            <StatusPill status={t.status} />
            <span className="font-mono text-[13px] text-fg">{t.id}</span>
            {t.cls && <StatusPill status={t.cls} suffix={t.conf?.toFixed(2)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
