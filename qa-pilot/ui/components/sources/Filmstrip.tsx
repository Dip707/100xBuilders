"use client";
import { useEffect, useRef } from "react";
import { fileUrl } from "@/lib/api";
import type { Frame } from "@/lib/frames";

/**
 * Every page the crawl captured, as a horizontal strip.
 *
 * It is the same array the player scrubs, so clicking a thumbnail seeks the recording
 * rather than opening a second, separate view of the same crawl. The strip follows the
 * player while it is running - a recording that scrolled away from its own current frame
 * would be unreadable - but only ever scrolls itself, never the page.
 */
export function Filmstrip({ frames, runId, current, onSeek }: {
  frames: Frame[];
  runId: string;
  current: number;
  onSeek: (index: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-frame="${current}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [current]);

  if (frames.length === 0) return null;

  return (
    <section>
      <h2 className="flex items-baseline gap-2 px-1 pb-2 text-[13px] font-medium tracking-[0.2px] text-fg">
        Captured pages <span className="font-mono text-[12px] font-normal text-muted">{frames.length}</span>
      </h2>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Captured pages">
        {frames.map((f) => (
          <button
            key={f.index} type="button" role="tab" data-frame={f.index}
            aria-selected={f.index === current} title={f.label}
            onClick={() => onSeek(f.index)}
            className={`group shrink-0 overflow-hidden rounded-box border bg-console transition-colors ${
              f.index === current ? "border-fg" : "border-line hover:border-line-strong"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API path, not a static asset Next can optimise */}
            <img src={fileUrl(runId, f.rel)} alt={`Frame ${f.index}: ${f.label}`} loading="lazy" className="h-[110px] w-[176px] object-cover object-top" />
            <span className="block max-w-[176px] truncate border-t border-line px-2 py-1.5 text-left font-mono text-[10.5px] text-muted">
              {f.label}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
