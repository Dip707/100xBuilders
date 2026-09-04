"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";
import { BudgetCard } from "./BudgetCard";

const NAV = [
  { href: "/", label: "Overview", icon: "⌂" },
  { href: "/runs/new", label: "New run", icon: "＋" },
] as const;

const REFERENCE = [
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/ARCHITECTURE.md", label: "Architecture" },
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/README.md", label: "Documentation" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-app">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex size-8 items-center justify-center rounded-box bg-accent text-xs font-bold text-white">qp</span>
        <span className="text-[15px] font-semibold text-fg">qa-pilot</span>
      </div>

      <nav className="space-y-0.5 px-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href} href={item.href}
              className={`flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] transition-colors ${
                active ? "bg-accent-tint font-medium text-accent" : "text-fg hover:bg-inset"
              }`}
            >
              <span className="w-4 text-center text-muted" aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <p className="px-4 pb-1 pt-6 text-xs font-medium text-subtle">Reference</p>
      <nav className="space-y-0.5 px-2">
        {REFERENCE.map((item) => (
          <a
            key={item.href} href={item.href} target="_blank" rel="noreferrer"
            className="flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] text-fg hover:bg-inset"
          >
            <span className="w-4 text-center text-muted" aria-hidden="true">▤</span>
            <span className="flex-1">{item.label}</span>
            <span className="text-subtle" aria-hidden="true">↗</span>
          </a>
        ))}
      </nav>

      <div className="mt-auto space-y-2 p-3">
        <BudgetCard />
        <UserMenu />
      </div>
    </aside>
  );
}
