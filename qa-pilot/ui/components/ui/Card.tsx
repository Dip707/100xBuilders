export function Card({
  title, actions, children, padded = true,
}: { title?: string; actions?: React.ReactNode; children: React.ReactNode; padded?: boolean }) {
  return (
    <section className="rounded-card border border-line bg-surface">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          {title && <h2 className="text-[15px] font-semibold text-fg">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? "px-6 py-2" : ""}>{children}</div>
    </section>
  );
}

/** A form row inside a Card, separated from its neighbours by an inset hairline. */
export function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-line last:border-b-0">{children}</div>;
}
