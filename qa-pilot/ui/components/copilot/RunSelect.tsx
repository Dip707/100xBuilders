"use client";
import { useEffect, useRef } from "react";
import { Icon, StatusPill } from "@/components/ui";
import { hostOf, relativeTime } from "@/lib/format";
import { runLabel } from "@/lib/copilot";
import type { RunRecord } from "@/lib/api";

/**
 * Which run the copilot is working on. A chat resolves one by itself - the most recent
 * finished run, or whatever a message names - and then stays on it, so this is how a person
 * says which run they meant, before the first question or after an answer about the wrong one.
 * It hangs upward because it sits under the composer, at the bottom of the viewport.
 */
export function RunSelect({
  runs, value, open, onOpen, onSelect, disabled = false,
}: {
  /** The runs that may be picked, newest first; null while they are still loading. */
  runs: RunRecord[] | null;
  /** The run the chat is pinned to, or null for "whichever finished most recently". */
  value: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSelect: (runId: string | null) => void;
  /** True while a turn or a rerun is in flight: the run cannot change under a running rerun. */
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpen]);

  const selected = value ? runs?.find((r) => r.id === value) ?? null : null;
  // A pinned run the list does not carry - one still running, say - still names itself.
  const label = value ? (selected ? runLabel(selected) : value) : "Most recent finished run";

  const choose = (runId: string | null) => {
    onSelect(runId);
    onOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => onOpen(!open)}
        disabled={disabled}
        aria-expanded={open}
        aria-label="Run the copilot works on"
        className="inline-flex h-7 max-w-[320px] items-center gap-1.5 rounded-input border border-line px-2 text-[12.5px] text-body transition-colors hover:bg-selected hover:text-fg disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-transparent"
      >
        <Icon name="play" size={11} className="shrink-0 text-muted" />
        <span className="truncate">{label}</span>
        <Icon name="chevronUpDown" size={11} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[336px] overflow-hidden rounded-box border border-line bg-raised">
          <button
            type="button"
            onClick={() => choose(null)}
            className={`flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left text-[13px] text-fg transition-colors hover:bg-selected ${value === null ? "bg-selected" : ""}`}
          >
            <Icon name="check" size={13} className={value === null ? "text-fg" : "text-transparent"} />
            Most recent finished run
          </button>

          {runs === null ? (
            <p className="px-3 py-3 text-[12.5px] text-muted">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-muted">No finished runs yet.</p>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto">
              {runs.map((run) => (
                <li key={run.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => choose(run.id)}
                    className={`flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-selected ${run.id === value ? "bg-selected" : ""}`}
                  >
                    <Icon name="check" size={13} className={`mt-0.5 shrink-0 ${run.id === value ? "text-fg" : "text-transparent"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{hostOf(run.url)}</span>
                        {/* The outcome, or - for a run that did not finish cleanly, which has none - why. */}
                        {run.testsPassed != null ? (
                          <span className="shrink-0 font-mono text-[12px] tabular-nums">
                            <span className="text-pass">{run.testsPassed}</span>
                            <span className="text-subtle"> / </span>
                            <span className={run.testsFailed ? "text-fail" : "text-muted"}>{run.testsFailed ?? 0}</span>
                          </span>
                        ) : (
                          <StatusPill status={run.status} />
                        )}
                      </span>
                      {/* The id in full: it is what the person matches against a run page or a link. */}
                      <span className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted">
                        <span className="font-mono">{run.id}</span>
                        <span className="text-subtle">·</span>
                        {relativeTime(run.startedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
