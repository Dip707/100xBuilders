import Link from "next/link";

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-subtle" aria-hidden="true">›</span>}
          {item.href ? (
            <Link href={item.href} className="text-muted hover:text-fg">{item.label}</Link>
          ) : (
            <span className="font-medium text-fg">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
