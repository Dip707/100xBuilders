"use client";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@/lib/auth";
import { Icon, ThemeToggle } from "@/components/ui";

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
    <div className="flex items-center gap-1">
      <div ref={ref} className="relative min-w-0 flex-1">
        {open && (
          <div className="absolute bottom-full left-0 mb-1.5 w-full overflow-hidden rounded-input border border-line bg-raised">
            <button onClick={signOut} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] text-body transition-colors hover:bg-selected hover:text-fg">
              <Icon name="logOut" size={14} /> Log out
            </button>
          </div>
        )}
        <button
          onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
          className="flex w-full items-center gap-2 rounded-input px-1.5 py-1.5 text-left transition-colors hover:bg-selected"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-chip bg-raised text-[10px] font-semibold text-body">{initials}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{user?.email ?? "…"}</span>
          <Icon name="chevronUpDown" size={13} className="text-subtle" />
        </button>
      </div>
      <ThemeToggle />
    </div>
  );
}
