"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";
import { BudgetCard } from "./BudgetCard";

const REFERENCE = [
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/ARCHITECTURE.md", label: "Architecture" },
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/README.md", label: "Documentation" },
] as const;

type Item = { href: string; label: string; icon: string; exact?: boolean };

/** The run id when the current page is inside a run, else null. "new" is the start form, not a run. */
export function runIdFromPath(pathname: string): string | null {
  const m = /^\/runs\/([^/]+)/.exec(pathname);
  if (!m || m[1] === "new") return null;
  return decodeURIComponent(m[1]);
}

function Section({ title, items, pathname }: { title: string; items: Item[]; pathname: string }) {
  return (
    <>
      <p className="px-4 pb-1 pt-5 text-xs font-medium text-subtle">{title}</p>
      <nav className="space-y-0.5 px-2">
        {items.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href} href={item.href} aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] transition-colors ${active ? "bg-accent-tint font-medium text-accent" : "text-fg hover:bg-inset"}`}
            >
              <span className="w-4 text-center text-muted" aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

/**
 * The reference's project sidebar. Outside a run it lists the account-level screens;
 * inside a run it becomes that run's workspace - Coverage, Test Cases, Test Runs - with a
 * Back link at the top, so the three run screens read as one place rather than three
 * pages that happen to share an id.
 */
export function Sidebar() {
  const pathname = usePathname();
  const runId = runIdFromPath(pathname);

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-app">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex size-8 items-center justify-center rounded-box bg-accent text-xs font-bold text-white">qp</span>
        <span className="text-[15px] font-semibold text-fg">qa-pilot</span>
      </div>

      {runId ? (
        <>
          <div className="px-2">
            <Link href="/" className="flex items-center gap-2 rounded-box px-2.5 py-2 text-[14px] text-muted hover:bg-inset hover:text-fg">
              <span aria-hidden="true">‹</span> Back to overview
            </Link>
            <p className="truncate px-2.5 pb-1 pt-1 font-mono text-[12px] text-subtle" title={runId}>{runId}</p>
          </div>
          <Section title="Setup" pathname={pathname} items={[{ href: "/runs/new", label: "New run", icon: "＋", exact: true }]} />
          <Section title="Workspace" pathname={pathname} items={[
            { href: `/runs/${encodeURIComponent(runId)}/coverage`, label: "Test coverage", icon: "⌘" },
            { href: `/runs/${encodeURIComponent(runId)}/cases`, label: "Test cases", icon: "☰" },
            { href: `/runs/${encodeURIComponent(runId)}`, label: "Test runs", icon: "▷", exact: true },
          ]} />
        </>
      ) : (
        <Section title="Workspace" pathname={pathname} items={[
          { href: "/", label: "Overview", icon: "⌂", exact: true },
          { href: "/runs/new", label: "New run", icon: "＋", exact: true },
        ]} />
      )}

      <p className="px-4 pb-1 pt-5 text-xs font-medium text-subtle">Reference</p>
      <nav className="space-y-0.5 px-2">
        {REFERENCE.map((item) => (
          <a key={item.href} href={item.href} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-box px-2.5 py-2.5 text-[15px] text-fg hover:bg-inset">
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
