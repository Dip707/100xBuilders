"use client";
import { useEffect, useRef, useState } from "react";
import { hasContent, probeTimes } from "@/lib/poster";

/**
 * A finished test's recording.
 *
 * Playwright starts recording before the app under test paints, so the clip opens on the
 * browser's blank page and that is the frame the player would otherwise sit on. This walks
 * the opening stretch looking for the first frame with something on it, captures it into a
 * `poster`, and rewinds - so the thumbnail shows the test rather than a white rectangle,
 * and pressing play still starts from the beginning.
 *
 * The walk needs two things from the API: byte-range support, without which the element
 * reports the recording as unseekable and refuses to move `currentTime`, and CORS headers
 * that cover credentialed requests, without which reading the frame back off the canvas
 * throws. Both are in place, and the poster is skipped rather than retried if either
 * regresses - a recording that plays with a blank thumbnail beats one that does not play.
 *
 * Keyed by `src` where it is rendered, so switching tests remounts rather than leaving the
 * previous test's poster on screen while the new recording loads.
 */
export function RecordingPlayer({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;

    /** Seeks and waits for the frame to land, giving up rather than hanging on a stall. */
    const seek = (time: number) =>
      new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => { clearTimeout(timer); video.removeEventListener("seeked", onSeeked); resolve(ok); };
        const onSeeked = () => done(true);
        const timer = setTimeout(() => done(false), 2000);
        video.addEventListener("seeked", onSeeked, { once: true });
        video.currentTime = time;
      });

    const findPoster = async () => {
      const times = probeTimes(video.duration);
      // seekable stays empty when the response carried no byte ranges; every seek would
      // silently clamp back to zero, so there is nothing to be gained by walking.
      if (times.length === 0 || video.seekable.length === 0 || video.seekable.end(0) === 0) return;

      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round((160 * video.videoHeight) / (video.videoWidth || 160)));
      const probe = canvas.getContext("2d", { willReadFrequently: true });
      if (!probe) return;

      for (const time of times) {
        if (cancelled) return;
        if (!(await seek(time)) || cancelled) return;
        probe.drawImage(video, 0, 0, canvas.width, canvas.height);
        let painted: boolean;
        try {
          painted = hasContent(probe.getImageData(0, 0, canvas.width, canvas.height).data);
        } catch {
          return; // Tainted canvas: leave the recording playable and skip the poster.
        }
        if (!painted) continue;
        // Re-captured at a legible size; the probe canvas is far too small to look at.
        const full = document.createElement("canvas");
        full.width = Math.min(video.videoWidth, 960);
        full.height = Math.round((full.width * video.videoHeight) / video.videoWidth);
        full.getContext("2d")?.drawImage(video, 0, 0, full.width, full.height);
        try {
          const url = full.toDataURL("image/jpeg", 0.8);
          if (!cancelled) setPoster(url);
        } catch {
          return;
        }
        break;
      }
      // Whether or not a frame was found, the recording should play from its start.
      if (!cancelled) await seek(0);
    };

    const onMetadata = () => { void findPoster(); };
    if (video.readyState >= 1) onMetadata();
    else video.addEventListener("loadedmetadata", onMetadata, { once: true });

    return () => { cancelled = true; video.removeEventListener("loadedmetadata", onMetadata); };
  }, [src]);

  return (
    <div className="overflow-hidden rounded-box border border-line bg-console">
      <video
        ref={ref}
        src={src}
        poster={poster ?? undefined}
        controls
        preload="metadata"
        // The API is a separate origin, so reading a frame back off the canvas needs the
        // credentialed CORS mode - the session cookie has to travel for the request to be
        // served at all, and an anonymous request would 401.
        crossOrigin="use-credentials"
        className="aspect-[16/10] w-full bg-console object-contain"
        aria-label={`Recording of ${label}`}
      />
    </div>
  );
}
