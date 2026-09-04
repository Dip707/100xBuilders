import { Breadcrumb } from "@/components/ui";

/**
 * The one header band every screen shares: a sticky 52px bar carrying the breadcrumb and
 * whatever actions the screen owns. It stays put while the content scrolls, so the trail
 * back out of a run is always reachable.
 *
 * The optional title block below it is for screens that need a stated subject; screens
 * with their own subject header (a run's URL, for instance) pass crumbs alone.
 */
export function PageHeader({
  crumbs, title, subtitle, actions,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <>
      <div className="sticky top-0 z-30 flex h-[52px] items-center justify-between gap-4 border-b border-line bg-app/85 px-6 backdrop-blur-md">
        <Breadcrumb items={crumbs} />
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {title && (
        <div className="space-y-1.5 px-6 pb-1 pt-7">
          <h1 className="text-[26px] font-medium leading-tight tracking-[0.2px] text-fg">{title}</h1>
          {subtitle && <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">{subtitle}</p>}
        </div>
      )}
    </>
  );
}
