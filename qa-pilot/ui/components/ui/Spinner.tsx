export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      role="status" aria-label="loading" style={{ width: size, height: size }}
      className="inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg"
    />
  );
}
