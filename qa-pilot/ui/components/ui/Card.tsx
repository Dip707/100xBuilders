/**
 * A hairline-bordered panel on the surface step of the ladder. There are no shadows in
 * this system: a card is one notch lighter than the canvas behind it, and that is the
 * whole of its elevation.
 */
export function Card({
  title, actions, children, padded = true, className = "",
}: { title?: string; actions?: React.ReactNode; children: React.ReactNode; padded?: boolean; className?: string }) {
  return (
    <section className={`overflow-hidden rounded-card border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          {title && <h2 className="whitespace-nowrap text-sm font-medium tracking-[0.2px] text-fg">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? "px-5 py-1" : ""}>{children}</div>
    </section>
  );
}

/** A form row inside a Card, separated from its neighbours by an inset hairline. */
export function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-line last:border-b-0">{children}</div>;
}
