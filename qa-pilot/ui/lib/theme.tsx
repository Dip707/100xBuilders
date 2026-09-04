"use client";
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "qa-pilot-theme";
const CHANGED = "qa-pilot:theme-changed";

/**
 * The theme is stored on `document.documentElement`, which the inline script in the root
 * layout sets from localStorage before first paint. That element is the source of truth,
 * not React state - so this reads it as an external store rather than mirroring it into
 * a useState, which keeps every toggle on the page in step and lets React handle the
 * server/client handoff with `getServerSnapshot`.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  // Another tab writing the key should move this one too.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const getSnapshot = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The server has no DOM and no localStorage, so it always renders the dark default. */
const getServerSnapshot = (): Theme => "dark";

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next: Theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A browser with site data blocked still gets the theme, just not across reloads.
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return { theme, toggle };
}
