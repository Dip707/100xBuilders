"use client";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui";
import type { Step } from "@/lib/frames";

const TONE: Record<Step["tone"], string> = {
  action: "text-body",
  note: "text-muted",
  error: "text-fail",
};

/**
 * What the explorer has done, in order.
 *
 * Actions the agent took carry the frame they captured, so the rail doubles as an index
 * into the recording; the notes and errors between them are what stop a long crawl reading
 * as an unexplained gap. It sticks to the newest step while the crawl is live and stops
 * following the moment the user scrolls up, which is the only way to read back through a
 * list that is still growing.
 */
export function StepsRail({ steps, pages, current, onSeek, live }: {
  steps: Step[];
  pages: number;
  current: number;
  onSeek: (frame: number) => void;
  live: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    const el = list.current;
    if (!el || !live || !follow.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps.length, live]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-box border border-line bg-inset">
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Steps</h3>
        <span className="font-mono text-[12px] tabular-nums text-fg">{steps.length}</span>
      </div>

      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {steps.length === 0 && <li className="px-1 py-3 text-[12.5px] text-subtle">The crawl has not reported a step yet.</li>}
        {steps.map((s) => {
          const seekable = s.frame !== null;
          const selected = s.frame === current;
          return (
            <li key={s.index}>
              <button
                type="button" disabled={!seekable}
                onClick={() => s.frame !== null && onSeek(s.frame)}
                className={`flex w-full items-baseline gap-2 rounded-input px-1.5 py-1.5 text-left transition-colors ${
                  selected ? "bg-selected" : seekable ? "hover:bg-selected" : "cursor-default"
                }`}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-subtle">{s.index}</span>
                <span className={`min-w-0 flex-1 text-[12.5px] leading-relaxed ${TONE[s.tone]}`}>
                  {s.tone === "error" && <Icon name="alert" size={11} className="mr-1 inline align-[-1px]" />}
                  {s.label}
                </span>
                {seekable && <Icon name="image" size={11} className={`shrink-0 ${selected ? "text-fg" : "text-subtle opacity-0 group-hover:opacity-100"}`} />}
              </button>
            </li>
          );
        })}
      </ol>

      <p className="flex items-baseline justify-between border-t border-line px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Pages visited</span>
        <span className="font-mono text-[12px] tabular-nums text-fg">{pages}</span>
      </p>
    </div>
  );
}
