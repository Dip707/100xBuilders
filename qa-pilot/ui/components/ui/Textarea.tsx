import type { TextareaHTMLAttributes } from "react";

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={`w-full rounded-input border border-line bg-inset px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-subtle focus:border-line-strong focus:outline-none ${className}`}
    />
  );
}
