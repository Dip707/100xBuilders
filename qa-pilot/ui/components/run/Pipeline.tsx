import { pipelineState } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function Pipeline({ events }: { events: RunEvent[] }) {
  // The review gate is optional; a run that never asked for it should not show an empty step.
  const nodes = pipelineState(events).filter((n) => n.node !== "review" || n.visits > 0);
  return (
    <div className="overflow-x-auto">
      <ol className="flex min-w-max items-center gap-1 py-1">
        {nodes.map((n, i) => {
          const visited = n.visits > 0;
          return (
            <li key={n.node} className="flex items-center gap-1">
              {i > 0 && <span className={`h-px w-6 ${visited ? "bg-accent" : "bg-line"}`} aria-hidden="true" />}
              <span
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  n.active
                    ? "animate-pulse border-accent bg-accent text-white"
                    : visited
                      ? "border-accent-tint bg-accent-tint text-accent"
                      : "border-line bg-surface text-subtle"
                }`}
              >
                <span aria-hidden="true">{n.active ? "◌" : visited ? "✓" : "○"}</span>
                {n.node}
                {n.visits > 1 && <span className="opacity-70">x{n.visits}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
