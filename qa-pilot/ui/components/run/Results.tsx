import { testRows, tally } from "@/lib/derive";
import { StatusPill } from "@/components/ui";
import type { RunEvent } from "@/lib/events";

export function Results({ events }: { events: RunEvent[] }) {
  const rows = testRows(events);
  const { passed, failed } = tally(rows);
  if (rows.length === 0) return <p className="p-4 text-[13px] text-muted">No tests have finished yet.</p>;

  return (
    <div className="h-full overflow-auto p-1">
      <div className="mb-3 flex gap-5 px-1 text-[13px]">
        <span><span className="text-base font-medium tabular-nums text-pass">{passed}</span> <span className="text-muted">passed</span></span>
        <span><span className="text-base font-medium tabular-nums text-fail">{failed}</span> <span className="text-muted">failed</span></span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-chip px-1.5 py-1.5 transition-colors hover:bg-selected">
            <StatusPill status={t.status} />
            <span className="font-mono text-[12.5px] text-body">{t.id}</span>
            {t.cls && <StatusPill status={t.cls} suffix={t.conf?.toFixed(2)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
