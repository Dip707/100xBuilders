import { decisionRows } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function Decisions({ events }: { events: RunEvent[] }) {
  const rows = decisionRows(events);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted">No branch decisions yet.</p>;
  return (
    <ol className="h-full space-y-3 overflow-auto p-1">
      {rows.map((d, i) => (
        <li key={i} className="border-l-2 border-accent pl-3">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <span className="text-fg">{d.node}</span>
            <span className="text-subtle" aria-hidden="true">→</span>
            <span className="text-accent">{d.next}</span>
          </div>
          <p className="mt-0.5 text-sm text-fg">{d.reason}</p>
          {d.evidence.length > 0 && (
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">{d.evidence.slice(0, 4).join(" · ")}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
