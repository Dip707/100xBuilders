import type { ButtonHTMLAttributes } from "react";

/*
 * Raycast's button set. The primary is a solid white pill - the system has no second
 * brand colour, and scarcity is the point: at most one solid primary per fold. Everything
 * else is monochrome, built from the surface ladder or a hairline outline.
 */
const VARIANTS = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-inset disabled:text-subtle disabled:cursor-not-allowed",
  outline: "border border-line-strong text-fg hover:bg-selected disabled:text-subtle disabled:border-line disabled:cursor-not-allowed",
  tertiary: "bg-inset text-fg hover:bg-raised disabled:text-subtle disabled:cursor-not-allowed",
  ghost: "text-muted hover:bg-selected hover:text-fg disabled:text-subtle",
} as const;

const SIZES = { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4 text-sm" } as const;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-input font-medium tracking-[0.2px] transition-colors ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    />
  );
}
