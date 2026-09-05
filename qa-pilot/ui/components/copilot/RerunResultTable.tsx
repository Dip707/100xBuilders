"use client";
import Link from "next/link";
import { Icon } from "@/components/ui";
import type { RerunResultData } from "@/lib/api";
import { formatDuration } from "@/lib/format";

const firstLine = (s: string) => s.split("\n")[0].trim();

/** The stored outcome of a rerun, drawn from the message so a reopened chat shows the same table. */
export function RerunResultTable({ result }: { result: RerunResultData }) {
  return (
    <div className="overflow-x-auto rounded-box border border-line bg-inset">
      <table className="w-full text-[13px]">
        <tbody>
          {result.results.map((r) => {
            const passed = r.status === "passed";
            return (
              <tr key={r.id} className="border-b border-line last:border-b-0">
                <td className="w-5 py-2 pl-3 align-top">
                  <span className={passed ? "text-pass" : "text-fail"}><Icon name={passed ? "check" : "x"} size={12} /></span>
                </td>
                <td className="py-2 pr-3 align-top">
                  <Link href={`/runs/${encodeURIComponent(result.runId)}/cases?test=${encodeURIComponent(r.id)}`} className="font-mono text-fg hover:underline">{r.id}</Link>
                  <span className="ml-2 text-muted">{r.title}</span>
                  {r.error && <p className="mt-0.5 text-[12px] text-fail">{firstLine(r.error)}</p>}
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-right align-top text-[12px] text-muted">
                  {passed ? "Passed" : "Failed"} · <span className="font-mono">{formatDuration(r.durationMs)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
