"use client";
import { useEffect, useRef } from "react";
import { feedRows } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

const COLORS: Record<string, string> = {
  explorer: "text-sky-300", planner: "text-violet-300", evaluator: "text-fuchsia-300",
  runner: "text-neutral-400", classifier: "text-orange-300", healer: "text-emerald-300",
  llm: "text-yellow-200", orchestrator: "text-white",
};

export function Feed({ events }: { events: RunEvent[] }) {
  const end = useRef<HTMLDivElement>(null);
  const rows = feedRows(events);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [rows.length]);

  return (
    <div className="h-full overflow-auto rounded-box bg-console p-3 font-mono text-xs leading-relaxed">
      {rows.length === 0 && <p className="text-neutral-500">waiting for the first agent log…</p>}
      {rows.map((e, i) => {
        const agent = (e.agent ?? "").split(":")[0];
        return (
          <div key={i} className={e.type === "error" ? "text-red-400" : COLORS[agent] ?? "text-neutral-300"}>
            <span className="text-neutral-600">{e.at.slice(11, 19)}</span>{" "}
            <span className="text-neutral-500">[{e.agent ?? "error"}]</span> {e.message}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
