import { reportUrl } from "@/lib/api";

export function ReportFrame({ runId, available }: { runId: string; available: boolean }) {
  if (!available) {
    return <p className="p-4 text-[13px] text-muted">No report yet. The report is written when the run reaches the report node.</p>;
  }
  return <iframe title="run report" src={reportUrl(runId)} className="h-full w-full rounded-box border border-line bg-white" />;
}
