"use client";
import { useState } from "react";
import { fileUrl } from "@/lib/api";
import { Card, Icon } from "@/components/ui";
import { isDone, latestScreenshotPath } from "@/lib/derive";
import { useScreencast, type Viewport } from "@/lib/screencast";
import type { RunEvent } from "@/lib/events";

/** "generator:checkout-flow" reads as "checkout-flow" once the tile is already labelled by role. */
function label(agent: string): string {
  const [role, rest] = agent.split(/:(.+)/);
  return rest ?? role;
}

function role(agent: string): string {
  return agent.split(":")[0];
}

function LiveBadge({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1.5 rounded-chip border border-line bg-inset px-2 py-1 text-[10.5px] font-medium uppercase leading-none tracking-[0.6px] text-subtle">
      <span className="size-1.5 animate-pulse rounded-full bg-[#ff6161]" aria-hidden="true" />
      {count > 1 ? `${count} live` : "Live"}
    </span>
  );
}

/**
 * What the agents' browsers are looking at, right now.
 *
 * While the run is live this is a real screencast: Chromium streams JPEG frames over CDP,
 * so it works with the browsers headless and shows every fanned-out generator at once
 * instead of a wall of Chromium windows. Once the run ends the stream closes and the panel
 * falls back to the last screenshot the agents saved to disk, which outlives the run.
 */
export function BrowserCard({ events, runId }: { events: RunEvent[]; runId: string }) {
  const live = useScreencast(runId, !isDone(events));
  const [pinned, setPinned] = useState<string | null>(null);
  const rel = latestScreenshotPath(events, runId);

  // A pinned agent that has since closed its browser must not blank the panel.
  const focused: Viewport | null = live.find((v) => v.agent === pinned) ?? live[0] ?? null;

  return (
    <Card title="Browser" padded={false} actions={live.length > 0 ? <LiveBadge count={live.length} /> : undefined}>
      <div className="space-y-2 p-3">
        {focused ? (
          <>
            <figure className="overflow-hidden rounded-box border border-line bg-console">
              {/* eslint-disable-next-line @next/next/no-img-element -- a base64 frame off the wire, not an asset Next can optimise */}
              <img src={focused.src} alt={`Live view of the ${focused.agent} browser`} className="aspect-[8/5] w-full object-contain" />
              <figcaption className="flex items-baseline gap-1.5 border-t border-line px-2.5 py-1.5 text-[11.5px]">
                <span className="text-subtle">{role(focused.agent)}</span>
                {label(focused.agent) !== role(focused.agent) && (
                  <span className="truncate font-mono text-[11px] text-muted">{label(focused.agent)}</span>
                )}
              </figcaption>
            </figure>

            {/* Generate fans out one browser per planned flow; the strip is how you get to them. */}
            {live.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Agent browsers">
                {live.map((v) => (
                  <button
                    key={v.agent} role="tab" aria-selected={v.agent === focused.agent} title={v.agent}
                    onClick={() => setPinned(v.agent)}
                    className={`shrink-0 overflow-hidden rounded-input border transition-colors ${
                      v.agent === focused.agent ? "border-fg" : "border-line hover:border-muted"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                    <img src={v.src} alt="" className="h-11 w-[70px] object-cover" />
                  </button>
                ))}
              </div>
            )}
          </>
        ) : rel ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API path, not a static asset Next can optimise
          <img src={fileUrl(runId, rel)} alt="Latest exploration screenshot" className="w-full rounded-box border border-line" />
        ) : (
          <div className="flex h-36 flex-col items-center justify-center gap-2 rounded-box border border-line bg-inset text-[13px] text-subtle">
            <Icon name="image" size={18} /> {isDone(events) ? "no screenshot captured" : "waiting for the first frame…"}
          </div>
        )}
      </div>
    </Card>
  );
}
