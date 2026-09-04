import { NODES, type RunEvent } from "@/lib/events";

export function Pipeline({ events }: { events: RunEvent[] }) {
  const visits: Record<string, number> = {};
  let active: string | null = null;
  for (const e of events) {
    if (e.type === "node_start" && e.node) { visits[e.node] = (visits[e.node] ?? 0) + 1; active = e.node; }
    if (e.type === "done") active = null;
  }
  return (
    <div className="flex gap-2 flex-wrap">
      {NODES.map((n) => (
        <div key={n} className={`px-3 py-1 rounded-full text-sm border ${active === n ? "bg-amber-400 text-black border-amber-500 animate-pulse" : visits[n] ? "bg-emerald-700 border-emerald-600" : "bg-neutral-800 border-neutral-700 text-neutral-400"}`}>
          {n}{visits[n] > 1 ? ` x${visits[n]}` : ""}
        </div>
      ))}
    </div>
  );
}
