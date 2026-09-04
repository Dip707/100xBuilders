import { PRIORITY_LABEL, type Priority } from "@/lib/cases";

const DOT: Record<Priority, string> = { P0: "bg-defect", P1: "bg-fail", P2: "bg-flaky", P3: "bg-pass" };

/** A priority chip: a coloured dot and a word, right-aligned in its column. */
export function PriorityTag({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip border border-line bg-inset px-2 py-1 text-[11.5px] font-medium leading-none tracking-[0.2px] text-body">
      <span className={`size-1.5 rounded-full ${DOT[priority]}`} aria-hidden="true" />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
