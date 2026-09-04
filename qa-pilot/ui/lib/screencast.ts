"use client";
import { useEffect, useState } from "react";
import { API } from "./api";

export type Viewport = { agent: string; src: string; at: number };

/**
 * Live viewports of the agents' browsers, keyed by agent name.
 *
 * The frames arrive on their own SSE stream rather than the run's event stream, because
 * that one replays its whole history on connect and frames are worthless once stale. This
 * hook therefore holds no history either: one current frame per agent, replaced in place.
 */
export function useScreencast(runId: string | null, active: boolean): Viewport[] {
  const [viewports, setViewports] = useState<Record<string, Viewport>>({});
  const [tracked, setTracked] = useState({ runId, active });

  // Adjusted during render rather than in an effect, as React prescribes for state derived
  // from props. Clearing on `active` going false matters as much as on a change of run: the
  // stream closes when the run ends, and without this the panel would freeze on whichever
  // frame happened to arrive last instead of falling back to the saved screenshots.
  if (tracked.runId !== runId || tracked.active !== active) {
    setTracked({ runId, active });
    if (Object.keys(viewports).length) setViewports({});
  }

  useEffect(() => {
    if (!runId || !active) return;
    // Authenticated like the events route, so the session cookie has to be sent explicitly.
    const es = new EventSource(`${API}/screencast/${runId}`, { withCredentials: true });
    es.addEventListener("frame", (e) => {
      const message = e as MessageEvent;
      if (typeof message.data !== "string") return;
      const f = JSON.parse(message.data) as { agent: string; at: number; jpeg: string | null };
      setViewports((prev) => {
        // A null frame means that agent's browser closed; drop the tile rather than leaving
        // a frozen last picture that reads as a still-running agent.
        if (!f.agent || f.jpeg === null) {
          if (!f.agent || !(f.agent in prev)) return prev;
          const next = { ...prev };
          delete next[f.agent];
          return next;
        }
        return { ...prev, [f.agent]: { agent: f.agent, src: `data:image/jpeg;base64,${f.jpeg}`, at: f.at } };
      });
    });
    return () => es.close();
  }, [runId, active]);

  // Stable order, so tiles do not reshuffle under the cursor as frames land.
  return Object.values(viewports).sort((a, b) => a.agent.localeCompare(b.agent));
}
