import type { TextareaHTMLAttributes } from "react";

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={`w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none ${className}`}
    />
  );
}
