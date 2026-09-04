export function Table({ children }: { children: React.ReactNode }) {
  // Wide content scrolls inside its own container so the page body never scrolls sideways.
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => (
  <th className={`border-b border-line px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.6px] text-subtle ${className}`}>{children}</th>
);
export const Td = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => (
  <td className={`border-b border-line px-4 py-3 align-middle text-body ${className}`}>{children}</td>
);
