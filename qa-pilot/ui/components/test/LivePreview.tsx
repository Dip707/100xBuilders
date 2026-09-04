"use client";
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/api";

/**
 * The browser as it is being driven. The runner streams JPEG frames to a file that is
 * rewritten several times a second; this polls that file with a cache-buster while the
 * test runs and keeps the last good frame on screen, so a 404 before the first frame or a
 * half-written file never flashes a broken image.
 */
export function LivePreview({ runId, relPath, active, fps = 4 }: { runId: string; relPath: string; active: boolean; fps?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const url = `${fileUrl(runId, relPath)}?t=${Date.now()}`;
      const img = new Image();
      img.onload = () => { if (!cancelled) setSrc(url); schedule(); };
      img.onerror = () => schedule();
      img.src = url;
    };
    const schedule = () => { if (!cancelled && active) timer = setTimeout(tick, 1000 / fps); };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runId, relPath, active, fps]);

  return (
    <div className="relative overflow-hidden rounded-box border border-line bg-console">
      {active && (
        <span className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-chip border border-white/10 bg-black/70 px-2 py-1 text-[10.5px] font-medium uppercase leading-none tracking-[0.6px] text-white backdrop-blur-sm">
          <span className="size-1.5 animate-pulse rounded-full bg-[#ff6161]" aria-hidden="true" /> Live
        </span>
      )}
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated, cache-busted API path
        <img src={src} alt="Live view of the browser running this test" className="aspect-[16/10] w-full object-contain" />
      ) : (
        <div className="flex aspect-[16/10] items-center justify-center text-[13px] text-[#6a6b6c]">
          {active ? "waiting for the first frame…" : "no preview captured"}
        </div>
      )}
    </div>
  );
}
