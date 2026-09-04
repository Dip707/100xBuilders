import { useEffect, useRef } from "react";
import type { RunEvent } from "@/lib/events";

const COLORS: Record<string, string> = { explorer: "text-sky-300", planner: "text-violet-300", evaluator: "text-fuchsia-300", runner: "text-neutral-400", classifier: "text-orange-300", healer: "text-emerald-300", llm: "text-yellow-200", orchestrator: "text-white" };

export function Feed({ events }: { events: RunEvent[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);
  const rows = events.filter((e) => e.type === "agent_log" || e.type === "error").slice(-300);
  return (
    <div className="h-72 overflow-auto font-mono text-xs space-y-0.5">
      {rows.map((e, i) => {
        const agent = (e.agent ?? "").split(":")[0];
        return <div key={i} className={e.type === "error" ? "text-red-400" : COLORS[agent] ?? "text-neutral-300"}><span className="opacity-50">{e.at.slice(11, 19)}</span> [{e.agent ?? "error"}] {e.message}</div>;
      })}
      <div ref={end} />
    </div>
  );
}
