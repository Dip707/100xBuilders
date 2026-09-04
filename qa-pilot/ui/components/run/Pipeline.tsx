import { pipelineState } from "@/lib/derive";
import { Icon } from "@/components/ui";
import type { RunEvent } from "@/lib/events";

/**
 * The orchestration graph as a stepper. The active node is the only filled chip on the
 * strip, which is the system's rule about scarcity applied to state: one solid fill per
 * view, and it marks the thing that is happening right now.
 */
export function Pipeline({ events }: { events: RunEvent[] }) {
  // The review gate is optional; a run that never asked for it should not show an empty step.
  const nodes = pipelineState(events).filter((n) => n.node !== "review" || n.visits > 0);
  return (
    <div className="overflow-x-auto">
      <ol className="flex min-w-max items-center gap-1 py-0.5">
        {nodes.map((n, i) => {
          const visited = n.visits > 0;
          return (
            <li key={n.node} className="flex items-center gap-1">
              {i > 0 && <span className={`h-px w-5 ${visited ? "bg-line-strong" : "bg-line"}`} aria-hidden="true" />}
              <span
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-chip border px-2.5 py-1 text-[12.5px] font-medium tracking-[0.2px] transition-colors ${
                  n.active
                    ? "border-info/40 bg-info/12 text-info"
                    : visited
                      ? "border-line bg-inset text-body"
                      : "border-line bg-transparent text-subtle"
                }`}
              >
                <Icon
                  name={n.active ? "dashedCircle" : visited ? "check" : "dot"}
                  size={11}
                  className={n.active ? "animate-spin [animation-duration:2.4s]" : visited ? "" : "opacity-50"}
                />
                {n.node}
                {n.visits > 1 && <span className="font-mono opacity-60">×{n.visits}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
