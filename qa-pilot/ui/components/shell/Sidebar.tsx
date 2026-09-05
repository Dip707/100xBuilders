"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";
import { openPalette } from "./CommandPalette";
import { BudgetCard } from "./BudgetCard";
import { Icon, Keycap, LogoLockup, type IconName } from "@/components/ui";
import { useRunOrNull } from "@/lib/run-context";
import { runIdFromPath, stageHref, type Stage } from "@/lib/stages";

const REFERENCE = [
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/ARCHITECTURE.md", label: "Architecture" },
  { href: "https://github.com/Dip707/100xBuilders/blob/main/qa-pilot/README.md", label: "Documentation" },
] as const;

type Item = { href: string; label: string; icon: IconName; exact?: boolean; badge?: React.ReactNode };

/**
 * A stage's badge on the rail: the word the reference uses for a stage nothing has reached
 * yet, and a pulsing dot for the one running right now. A finished stage carries nothing -
 * the rail would be four badges of noise if every state got one, and "done" is the state
 * you least need telling about.
 */
function StageBadge({ status }: { status: Stage["status"] }) {
  if (status === "active") {
    return (
      <span className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase leading-none tracking-[0.5px] text-info">
        <span className="size-1.5 animate-pulse rounded-full bg-info" aria-hidden="true" />
        Live
      </span>
    );
  }
  if (status === "complete") return null;
  return (
    <span className="rounded-chip border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-[0.4px] text-subtle">
      {status === "not_run" ? "Not run" : "Not started"}
    </span>
  );
}

function Section({ title, items, pathname }: { title: string; items: Item[]; pathname: string }) {
  return (
    <div className="pt-5">
      <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">{title}</p>
      <nav className="space-y-px">
        {items.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href} href={item.href} aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-input px-2.5 py-2 text-[13.5px] tracking-[0.1px] transition-colors ${
                active ? "bg-selected font-medium text-fg" : "text-muted hover:bg-selected hover:text-fg"
              }`}
            >
              <Icon name={item.icon} size={15} />
              <span className="flex-1 truncate">{item.label}</span>
              {item.badge}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The project rail. Outside a run it lists the account-level screens; inside a run it
 * becomes that run's workspace - Coverage, Test Cases, Test Runs - with a back link at the
 * top, so the three run screens read as one place rather than three pages that happen to
 * share an id. An active item lifts by one surface notch; the system has no accent tint
 * to spend on navigation.
 */
export function Sidebar() {
  const pathname = usePathname();
  const runId = runIdFromPath(pathname);
  const run = useRunOrNull();

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-line bg-app">
      <Link href="/" className="flex items-center px-4 pb-3 pt-4" aria-label="AEGIS home">
        <LogoLockup />
      </Link>

      {/*
        Not a real input: the palette owns the search field. This is the affordance that
        tells a first-time visitor the shortcut exists at all.
      */}
      <div className="px-2.5">
        <button
          type="button"
          onClick={openPalette}
          className="flex w-full items-center gap-2 rounded-input border border-line bg-inset px-2.5 py-1.5 text-[13px] text-subtle transition-colors hover:border-line-strong hover:text-muted"
        >
          <Icon name="search" size={14} />
          <span className="flex-1 text-left">Search…</span>
          <Keycap>⌘K</Keycap>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {runId ? (
          <>
            <div className="pt-4">
              <Link href="/" className="flex items-center gap-1.5 rounded-input px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-selected hover:text-fg">
                <Icon name="chevronLeft" size={14} /> Back to overview
              </Link>
              <p className="truncate px-2.5 pt-1 font-mono text-[11px] text-subtle" title={runId}>{runId}</p>
            </div>
            <Section title="Setup" pathname={pathname} items={[
              { href: "/runs/new", label: "New run", icon: "plus", exact: true },
              { href: "/copilot", label: "Copilot", icon: "sparkles", exact: true },
            ]} />
            {/*
              The workspace in pipeline order, each stage badged with where the run has
              actually got to. Every one stays clickable: a stage that has not started
              shows what it is waiting on, which is more use than a dead link.
            */}
            <Section title="Workspace" pathname={pathname} items={(run?.stages ?? []).map((stage) => ({
              href: stageHref(runId, stage.id),
              label: stage.label,
              icon: stage.icon,
              exact: stage.id === "runs",
              badge: <StageBadge status={stage.status} />,
            }))} />
          </>
        ) : (
          <Section title="Workspace" pathname={pathname} items={[
            { href: "/", label: "Overview", icon: "home", exact: true },
            { href: "/runs/new", label: "New run", icon: "plus", exact: true },
            { href: "/copilot", label: "Copilot", icon: "sparkles", exact: true },
          ]} />
        )}

        <div className="pt-5">
          <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">Reference</p>
          <nav className="space-y-px">
            {REFERENCE.map((item) => (
              <a
                key={item.href} href={item.href} target="_blank" rel="noreferrer"
                className="flex items-center gap-2.5 rounded-input px-2.5 py-2 text-[13.5px] text-muted transition-colors hover:bg-selected hover:text-fg"
              >
                <Icon name="book" size={15} />
                <span className="flex-1">{item.label}</span>
                <Icon name="externalLink" size={12} className="opacity-50" />
              </a>
            ))}
          </nav>
        </div>
      </div>

      <div className="space-y-2 border-t border-line p-2.5">
        <BudgetCard />
        <UserMenu />
      </div>
    </aside>
  );
}
