import type { InputHTMLAttributes } from "react";

// Focus brightens the hairline rather than painting a coloured ring - the system never
// puts an accent hue on chrome.
const BASE =
  "w-full rounded-input border border-line bg-inset px-3 text-sm text-fg placeholder:text-subtle focus:border-line-strong focus:outline-none disabled:text-subtle disabled:opacity-60";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${BASE} h-9 ${className}`} />;
}
