"use client";
import { useTheme } from "@/lib/theme";
import { Icon } from "./Icon";

/**
 * Raycast's own system is dark-only, so the light half here is a derived counterpart: the
 * same geometry and the same token names with the surface ladder inverted.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className="flex size-8 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg"
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} className={className} />
    </button>
  );
}
