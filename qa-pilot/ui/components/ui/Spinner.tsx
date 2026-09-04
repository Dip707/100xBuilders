export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status" aria-label="loading" style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-line border-t-accent"
    />
  );
}
