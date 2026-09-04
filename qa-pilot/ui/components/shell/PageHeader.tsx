import { Breadcrumb } from "@/components/ui";

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
      <div className="flex items-center justify-between gap-4 border-b border-line px-8 py-4">
        <Breadcrumb items={crumbs} />
        {actions}
      </div>
      {title && (
        <div className="space-y-2 px-8 pb-2 pt-8">
          <h1 className="text-[28px] font-semibold leading-tight text-fg">{title}</h1>
          {subtitle && <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{subtitle}</p>}
        </div>
      )}
    </>
  );
}
