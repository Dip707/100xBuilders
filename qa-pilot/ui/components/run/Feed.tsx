"use client";
import { useEffect, useRef } from "react";
import { feedRows } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

/*
 * Agent colours. The log pane is the one surface where the saturated accents earn their
 * keep as identity rather than status: at a glance you can see which sub-agent is talking
 * without reading the bracketed name.
 */
const COLORS: Record<string, string> = {
  explorer: "text-[#57c1ff]", planner: "text-[#b08cff]", evaluator: "text-[#f472d0]",
  runner: "text-[#9c9c9d]", classifier: "text-[#ffa657]", healer: "text-[#59d499]",
  llm: "text-[#ffc533]", orchestrator: "text-white",
};

export function Feed({ events }: { events: RunEvent[] }) {
  const end = useRef<HTMLDivElement>(null);
  const rows = feedRows(events);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [rows.length]);

  return (
    <div className="h-full overflow-auto rounded-box border border-line bg-console p-3 font-mono text-[11.5px] leading-[1.7]">
      {rows.length === 0 && <p className="text-[#6a6b6c]">waiting for the first agent log…</p>}
      {rows.map((e, i) => {
        const agent = (e.agent ?? "").split(":")[0];
        return (
          <div key={i} className={e.type === "error" ? "text-[#ff6161]" : COLORS[agent] ?? "text-[#cdcdcd]"}>
            <span className="text-[#434345]">{e.at.slice(11, 19)}</span>{" "}
            <span className="text-[#6a6b6c]">[{e.agent ?? "error"}]</span> {e.message}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
