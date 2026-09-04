"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table, Th, Td, StatusPill, Meter } from "@/components/ui";
import { relativeTime, formatDuration, hostOf } from "@/lib/format";
import type { RunRecord } from "@/lib/api";

export function RunTable({ runs }: { runs: RunRecord[] }) {
  const router = useRouter();
  return (
    <Table>
      <thead>
        <tr>
          <Th>Status</Th><Th>Target</Th><Th>Started</Th><Th>Duration</Th>
          <Th className="w-32">Coverage</Th><Th>Tests</Th><Th>Defects</Th><Th>Heals</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr
            key={run.id} onClick={() => router.push(`/runs/${run.id}`)}
            className="cursor-pointer transition-colors hover:bg-inset"
          >
            <Td><StatusPill status={run.status} /></Td>
            <Td>
              <Link
                href={`/runs/${run.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono text-[13px] hover:underline"
              >
                {hostOf(run.url)}
              </Link>
              {run.intent && <span className="ml-2 text-[13px] text-muted">{run.intent}</span>}
            </Td>
            <Td className="whitespace-nowrap text-muted">{relativeTime(run.startedAt)}</Td>
            <Td className="whitespace-nowrap text-muted">{formatDuration(run.durationMs)}</Td>
            <Td>
              {run.coverageScore === undefined
                ? <span className="text-subtle">-</span>
                : <Meter value={run.coverageScore} label={run.coverageScore.toFixed(2)} />}
            </Td>
            <Td className="whitespace-nowrap">
              {run.testsPassed === undefined ? <span className="text-subtle">-</span> : (
                <span className="font-mono text-[13px]">
                  <span className="text-pass">{run.testsPassed}</span>
                  <span className="text-subtle"> / </span>
                  <span className={run.testsFailed ? "text-fail" : "text-muted"}>{run.testsFailed ?? 0}</span>
                </span>
              )}
            </Td>
            <Td className={run.defectsCount ? "font-medium text-defect" : "text-subtle"}>{run.defectsCount ?? "-"}</Td>
            <Td className="text-muted">{run.healsAccepted ?? "-"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
