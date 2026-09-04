/**
 * The keyboard-shortcut glyph. Raycast's only piece of skeuomorphism: a faint vertical
 * gradient across a small rounded tile that reads as a physical key face on an otherwise
 * completely flat canvas.
 */
export function Keycap({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={`keycap-face inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-line px-1.5 font-sans text-[11px] font-medium text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}
