import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/40 disabled:cursor-not-allowed",
  outline: "bg-surface text-fg border border-line-strong hover:bg-inset disabled:text-subtle",
  ghost: "text-muted hover:bg-inset hover:text-fg",
} as const;

const SIZES = { sm: "h-8 px-3 text-sm", md: "h-10 px-5 text-sm" } as const;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    />
  );
}
