import type { InputHTMLAttributes } from "react";

const BASE = "w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none disabled:bg-inset";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${BASE} h-10 ${className}`} />;
}
