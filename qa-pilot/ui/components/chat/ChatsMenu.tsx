"use client";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui";
import { relativeTime, hostOf } from "@/lib/format";
import type { ChatSummary } from "@/lib/api";

/**
 * The chats dropdown. Every conversation is saved, so this is how you get back to the one
 * where you already worked out what to test - and, once a chat has started a run, to the run
 * it produced.
 */
export function ChatsMenu({
  chats, currentId, open, onOpen, onSelect, onNew, onDelete, align = "left",
}: {
  chats: ChatSummary[];
  /** Which edge of the button the list hangs from. Right, for a menu sitting at the end of a header. */
  align?: "left" | "right";
  currentId: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
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

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => onOpen(!open)}
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-input px-2 text-[13px] font-medium tracking-[0.2px] text-fg transition-colors hover:bg-selected"
      >
        Chats <Icon name="chevronDown" size={12} className="text-muted" />
      </button>

      {open && (
        <div className={`absolute top-8 z-30 w-[268px] overflow-hidden rounded-box border border-line bg-raised ${align === "right" ? "right-0" : "left-0"}`}>
          <button
            type="button"
            onClick={() => { onNew(); onOpen(false); }}
            className="flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left text-[13px] text-fg transition-colors hover:bg-selected"
          >
            <Icon name="plus" size={13} className="text-muted" /> New chat
          </button>

          {chats.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-muted">No saved chats yet.</p>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto">
              {chats.map((chat) => (
                <li key={chat.id} className="group flex items-center gap-1 border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => { onSelect(chat.id); onOpen(false); }}
                    className={`min-w-0 flex-1 px-3 py-2.5 text-left transition-colors hover:bg-selected ${chat.id === currentId ? "bg-selected" : ""}`}
                  >
                    <span className="block truncate text-[13px] text-fg">{chat.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                      {relativeTime(chat.updatedAt)}
                      {chat.url && <><span className="text-subtle">·</span><span className="truncate">{hostOf(chat.url)}</span></>}
                      {chat.runId && <><span className="text-subtle">·</span><Icon name="play" size={9} /> ran</>}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(chat.id)}
                    aria-label={`Delete ${chat.title}`}
                    className="mr-2 hidden h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fail group-hover:flex"
                  >
                    <Icon name="trash" size={13} />
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
