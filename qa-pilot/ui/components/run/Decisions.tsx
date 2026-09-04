import { decisionRows } from "@/lib/derive";
import { Icon } from "@/components/ui";
import type { RunEvent } from "@/lib/events";

export function Decisions({ events }: { events: RunEvent[] }) {
  const rows = decisionRows(events);
  if (rows.length === 0) return <p className="p-4 text-[13px] text-muted">No branch decisions yet.</p>;
  return (
    <ol className="h-full space-y-2.5 overflow-auto p-1">
      {rows.map((d, i) => (
        <li key={i} className="rounded-box border border-line bg-inset px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
            <span className="font-mono text-muted">{d.node}</span>
            <Icon name="arrowRight" size={12} className="text-subtle" />
            <span className="font-mono text-fg">{d.next}</span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-body">{d.reason}</p>
          {d.evidence.length > 0 && (
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-subtle">{d.evidence.slice(0, 4).join(" · ")}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
