import Link from "next/link";
import { Icon } from "./Icon";

/**
 * Only the middle crumbs shrink. Letting every crumb truncate equally turned
 * "Runs > <run id> > Test coverage" into "R.. > ui-re… > Te…" as soon as the header
 * actions got wide - the two ends are short and are what orient you, so the long run id
 * in the middle is the one that gives way.
 */
export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {items.map((item, i) => {
        const elastic = i > 0 && i < items.length - 1;
        return (
          <span key={i} className={`flex items-center gap-1.5 ${elastic ? "min-w-0" : "shrink-0"}`}>
            {i > 0 && <Icon name="chevronRight" size={13} className="shrink-0 text-subtle" />}
            {item.href ? (
              <Link href={item.href} className={`text-muted transition-colors hover:text-fg ${elastic ? "truncate" : "whitespace-nowrap"}`}>{item.label}</Link>
            ) : (
              <span className={`font-medium text-fg ${elastic ? "truncate" : "whitespace-nowrap"}`}>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
