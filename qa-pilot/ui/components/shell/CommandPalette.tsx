"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, Keycap, type IconName } from "@/components/ui";
import { useTheme } from "@/lib/theme";
import { listRuns, type RunRecord } from "@/lib/api";
import { hostOf, relativeTime } from "@/lib/format";

type Command = { id: string; label: string; hint?: string; icon: IconName; section: string; run: () => void };

const OPEN_EVENT = "qa-pilot:open-palette";

/** Opens the palette from anywhere - the sidebar's search affordance uses this. */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Case-insensitive subsequence match, so "nr" finds "New run" the way a launcher should. */
function matches(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const s = haystack.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    i = s.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

/**
 * The ⌘K launcher. Raycast's command palette is the shape the whole design system is
 * derived from, so the app that borrows the system should be drivable the same way:
 * every screen, every recent run and the theme are one keystroke and a few letters away.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { toggle } = useTheme();

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }, []);

  // The runs list is only fetched while the palette is actually open, and refetched on
  // each open so a run started a moment ago is already in the list.
  useEffect(() => {
    if (!open) return;
    listRuns().then(setRuns).catch(() => setRuns([]));
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key?.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => { close(); router.push(href); };
    const nav: Command[] = [
      { id: "overview", label: "Go to overview", icon: "home", section: "Navigation", run: go("/") },
      { id: "new", label: "Start a run", hint: "Explore, plan, generate, execute", icon: "plus", section: "Actions", run: go("/runs/new") },
      { id: "theme", label: "Toggle theme", icon: "sun", section: "Actions", run: () => { toggle(); close(); } },
    ];
    const recent: Command[] = runs.slice(0, 8).map((r) => ({
      id: r.id,
      label: hostOf(r.url),
      hint: `${r.status} · ${relativeTime(r.startedAt)}${r.intent ? ` · ${r.intent}` : ""}`,
      icon: "play" as const,
      section: "Recent runs",
      run: go(`/runs/${encodeURIComponent(r.id)}`),
    }));
    return [...nav, ...recent];
  }, [runs, router, toggle, close]);

  const shown = useMemo(
    () => commands.filter((c) => matches(`${c.label} ${c.hint ?? ""} ${c.section}`, query)),
    [commands, query],
  );

  // Clamped during render rather than corrected in an effect: a shrinking result list can
  // leave `cursor` past the end, and deriving the active index means that state is never
  // observable as an out-of-range value.
  const active = Math.min(cursor, Math.max(0, shown.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /*
   * Bound on the window rather than as an onKeyDown on the dialog, so the palette keeps
   * working when focus is not inside it - autofocus can be refused, and clicking the
   * backdrop moves focus to the body. Only the four control keys are intercepted;
   * everything else falls through to the search input.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setCursor(shown.length ? (active + 1) % shown.length : 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(shown.length ? (active - 1 + shown.length) % shown.length : 0); }
      else if (e.key === "Enter") { e.preventDefault(); shown[active]?.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shown, active, close]);

  if (!open) return null;

  let lastSection: string | null = null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={close}
      role="presentation"
    >
      <div
        role="dialog" aria-modal="true" aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-palette-in flex max-h-[62vh] w-full max-w-[620px] flex-col overflow-hidden rounded-card border border-line bg-surface"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Icon name="search" size={17} className="text-subtle" />
          <input
            autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            placeholder="Search runs and commands…" aria-label="Search runs and commands"
            className="h-[52px] w-full bg-transparent text-[15px] text-fg placeholder:text-subtle focus:outline-none"
          />
          <Keycap>esc</Keycap>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
          {shown.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-muted">Nothing matches “{query}”.</p>}
          {shown.map((c, i) => {
            const header = c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            return (
              <div key={c.id}>
                {header && <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">{header}</p>}
                <button
                  type="button" data-active={i === active} onMouseMove={() => setCursor(i)} onClick={c.run}
                  className={`flex w-full items-center gap-3 rounded-chip px-2.5 py-2 text-left transition-colors ${i === active ? "bg-raised" : ""}`}
                >
                  <Icon name={c.icon} size={15} className={i === active ? "text-fg" : "text-muted"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-fg">{c.label}</span>
                    {c.hint && <span className="block truncate text-[12px] text-muted">{c.hint}</span>}
                  </span>
                  {i === active && <Keycap>↵</Keycap>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px] text-subtle">
          <span className="flex items-center gap-1.5"><Icon name="command" size={12} /> qa-pilot</span>
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1"><Keycap>↑</Keycap><Keycap>↓</Keycap> navigate</span>
            <span className="flex items-center gap-1"><Keycap>↵</Keycap> open</span>
          </span>
        </div>
      </div>
    </div>
  );
}
