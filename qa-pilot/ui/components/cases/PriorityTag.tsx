import { PRIORITY_LABEL, type Priority } from "@/lib/cases";

const DOT: Record<Priority, string> = { P0: "bg-defect", P1: "bg-fail", P2: "bg-flaky", P3: "bg-pass" };

/** The reference's priority pill: a coloured dot and a word, right-aligned in its column. */
export function PriorityTag({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-fg">
      <span className={`size-1.5 rounded-full ${DOT[priority]}`} aria-hidden="true" />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
