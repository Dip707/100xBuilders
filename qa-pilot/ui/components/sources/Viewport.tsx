"use client";
import { useEffect } from "react";
import { fileUrl } from "@/lib/api";
import { Icon } from "@/components/ui";
import { frameCaption, type Frame } from "@/lib/frames";

/** How long each frame is held during playback. Fast enough to read as motion, slow enough to read the caption. */
export const FRAME_MS = 700;

function LiveBadge() {
  return (
    <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-chip border border-line bg-app/85 px-2 py-1 text-[10.5px] font-medium uppercase leading-none tracking-[0.6px] text-fg backdrop-blur">
      <span className="size-1.5 animate-pulse rounded-full bg-[#ff6161]" aria-hidden="true" />
      Live
    </span>
  );
}

/**
 * The big picture on the Sources screen: the explorer's browser while it is crawling, the
 * recording of that crawl once it has finished.
 *
 * They are deliberately one surface rather than two. The live view and the recording show
 * the same browser doing the same thing, and the moment the crawl ends is exactly when the
 * frames become worth scrubbing - so the picture stays put and gains a transport, instead
 * of the user having to find a separate player somewhere else on the page.
 */
export function Viewport({ runId, liveSrc, frames, current, onSeek, playing, onPlayingChange }: {
  runId: string;
  /** The current screencast frame while the crawl is live; null once the stream has closed. */
  liveSrc: string | null;
  frames: Frame[];
  current: number;
  onSeek: (index: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
}) {
  const frame = frames[current - 1] ?? null;

  // Playback advances one frame at a time and stops on the last, so the recording ends on
  // the app's final state rather than looping back to a blank landing page.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const timer = setTimeout(() => {
      if (current >= frames.length) onPlayingChange(false);
      else onSeek(current + 1);
    }, FRAME_MS);
    return () => clearTimeout(timer);
  }, [playing, current, frames.length, onSeek, onPlayingChange]);

  const replay = () => {
    if (current >= frames.length) onSeek(1);
    onPlayingChange(!playing);
  };

  return (
    <div className="overflow-hidden rounded-box border border-line bg-surface">
      {/* The mat is deliberately dark in both themes - it is a browser viewport, not a panel. */}
      <div className="relative aspect-[8/5] w-full bg-console">
        {liveSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- a base64 frame off the wire, not an asset Next can optimise
          <img src={liveSrc} alt="Live view of the explorer's browser" className="size-full object-contain" />
        ) : frame ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API path, not a static asset Next can optimise
          <img src={fileUrl(runId, frame.rel)} alt={`Frame ${frame.index}: ${frame.label}`} className="size-full object-contain object-top" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-[13px] text-subtle">
            <Icon name="image" size={18} />
            {frames.length === 0 ? "waiting for the first frame…" : "no frame to show"}
          </div>
        )}
        {liveSrc && <LiveBadge />}
      </div>

      {/* The transport only exists once the crawl has stopped: there is nothing to scrub while it is still being recorded. */}
      {!liveSrc && frames.length > 0 && (
        <div className="flex items-center gap-3 border-t border-line px-3 py-2.5">
          <button
            type="button" onClick={replay}
            aria-label={playing ? "Pause the recording" : "Play the recording"}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg transition-colors hover:bg-selected"
          >
            <Icon name={playing ? "pause" : current >= frames.length ? "refresh" : "play"} size={13} />
          </button>
          <input
            type="range" min={1} max={frames.length} value={current}
            aria-label="Recording position"
            onChange={(e) => { onPlayingChange(false); onSeek(Number(e.target.value)); }}
            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-fg"
          />
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-subtle">{current}/{frames.length}</span>
        </div>
      )}

      {!liveSrc && frame && (
        <p className="truncate border-t border-line px-3 py-2 font-mono text-[11.5px] text-muted">{frameCaption(frame)}</p>
      )}
    </div>
  );
}
