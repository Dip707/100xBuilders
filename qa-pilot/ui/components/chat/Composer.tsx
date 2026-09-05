"use client";
import { useEffect, useRef } from "react";
import { Icon, Spinner } from "@/components/ui";

/**
 * The message box. Enter sends and shift-Enter breaks a line, which is the convention
 * everywhere else people type into a chat; the textarea grows to about five lines and then
 * scrolls, so a pasted paragraph never pushes the transcript off screen.
 */
export function Composer({
  value, onChange, onSend, onAttach, busy, placeholder = "Ask a question", ariaLabel = "Message the intake assistant",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Absent for a chat that takes no documents; the paperclip is not drawn. */
  onAttach?: (file: File) => void;
  busy: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  const ready = value.trim().length > 0 && !busy;

  return (
    <div className="rounded-box border border-line bg-inset p-2.5 focus-within:border-line-strong">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (ready) onSend();
          }
        }}
        rows={1}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="max-h-[132px] w-full resize-none bg-transparent px-1 text-[13.5px] leading-relaxed text-fg placeholder:text-subtle focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between">
        {onAttach ? (
          <label
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg"
            title="Attach a PRD"
          >
            <Icon name="paperclip" size={14} />
            <span className="sr-only">Attach a PRD</span>
            <input
              type="file"
              accept=".md,.txt,.markdown,text/plain,text/markdown"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so choosing the same file twice still fires a change event.
                e.target.value = "";
                if (file) onAttach(file);
              }}
            />
          </label>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => ready && onSend()}
          disabled={!ready}
          aria-label="Send"
          className="inline-flex h-7 w-7 items-center justify-center rounded-input bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:bg-raised disabled:text-subtle"
        >
          {busy ? <Spinner size={12} /> : <Icon name="arrowUp" size={14} />}
        </button>
      </div>
    </div>
  );
}
