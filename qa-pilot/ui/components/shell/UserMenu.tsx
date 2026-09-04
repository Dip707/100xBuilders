"use client";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@/lib/auth";

export function UserMenu() {
  const { user, signOut } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onDocumentClick); document.removeEventListener("keydown", onEscape); };
  }, [open]);

  const initials = (user?.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-box border border-line bg-surface shadow-lg">
          <button onClick={signOut} className="w-full px-3 py-2 text-left text-sm text-fg hover:bg-inset">Log out</button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-box px-2 py-2 text-left hover:bg-inset"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-white">{initials}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{user?.email ?? "…"}</span>
        <span className="text-subtle" aria-hidden="true">⌃</span>
      </button>
    </div>
  );
}
