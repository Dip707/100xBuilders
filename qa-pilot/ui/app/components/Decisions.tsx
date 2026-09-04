import type { RunEvent } from "@/lib/events";

export function Decisions({ events }: { events: RunEvent[] }) {
  const rows = events.filter((e) => e.type === "decision");
  return (
    <ol className="space-y-2 text-sm h-72 overflow-auto">
      {rows.map((e, i) => {
        const d = e.data as { node: string; reason: string; evidence: string[]; next: string };
        return (
          <li key={i} className="border-l-2 border-amber-400 pl-2">
            <div><span className="text-amber-300">{d.node}</span> → <span className="text-emerald-300">{d.next}</span></div>
            <div>{d.reason}</div>
            {d.evidence?.length > 0 && <div className="text-neutral-400 text-xs">{d.evidence.slice(0, 4).join(" · ")}</div>}
          </li>
        );
      })}
    </ol>
  );
}
