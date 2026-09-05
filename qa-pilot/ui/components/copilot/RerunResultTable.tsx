"use client";
import Link from "next/link";
import { Icon, Spinner } from "@/components/ui";
import { isUsableIntegration, type IntegrationPublic, type RerunResultData, type TicketRecord } from "@/lib/api";
import { formatDuration } from "@/lib/format";

const firstLine = (s: string) => s.split("\n")[0].trim();

/** The classifier's classes in the words the chat uses for them. */
const VERDICT_WORDS: Record<string, string> = {
  defect: "app defect",
  env: "environment error",
  script: "script bug",
  flaky: "flaky test",
  needs_human: "needs a human",
};

const PROVIDER_NAME = { linear: "Linear", jira: "Jira" } as const;

type Row = RerunResultData["results"][number];

/**
 * What a still-failing row can do about its verdict. The pipeline's classifier decides whether
 * a failure is the app's fault; only then is filing offered, so the product never invites a
 * ticket for a broken locator or an unreachable target.
 */
function TicketAction({
  row, integration, ticket, filing, onRaise, connectHref,
}: {
  row: Row;
  integration: IntegrationPublic | null | undefined;
  ticket: TicketRecord | undefined;
  filing: boolean;
  onRaise: () => void;
  connectHref: string;
}) {
  if (ticket) {
    return (
      <a
        href={ticket.url} target="_blank" rel="noreferrer" title={`Filed in ${PROVIDER_NAME[ticket.provider]}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-input border border-line px-2.5 font-mono text-[12px] text-fg transition-colors hover:bg-selected"
      >
        {ticket.key} <Icon name="externalLink" size={11} className="text-muted" />
      </a>
    );
  }
  if (row.verdict?.class !== "defect") return null;
  if (integration === undefined) return null;
  if (!isUsableIntegration(integration)) {
    // Nothing connected, or a connection that never came back from OAuth or has no team or
    // project picked yet: Settings is where that gets finished.
    return (
      <Link
        href={connectHref}
        className="inline-flex h-7 items-center gap-1.5 rounded-input border border-line px-2.5 text-[12px] font-medium text-body transition-colors hover:bg-selected hover:text-fg"
      >
        <Icon name="externalLink" size={11} className="text-muted" /> {integration ? `Finish connecting ${PROVIDER_NAME[integration.provider]}` : "Connect Linear or Jira"}
      </Link>
    );
  }
  if (filing) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 px-2.5 text-[12px] text-muted">
        <Spinner size={11} /> Filing in {PROVIDER_NAME[integration.provider]}
      </span>
    );
  }
  return (
    <button
      type="button" onClick={onRaise}
      className="inline-flex h-7 items-center gap-1.5 rounded-input bg-accent px-2.5 text-[12px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
    >
      <Icon name="bug" size={11} /> Raise in {PROVIDER_NAME[integration.provider]}
    </button>
  );
}

/** The verdict line under a still-failing row: a chip for a defect, a sentence for anything else. */
function Verdict({ row }: { row: Row }) {
  const verdict = row.verdict;
  if (!verdict) return null;
  if (verdict.class === "defect") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-chip bg-defect/12 px-2 py-0.5 text-[11.5px] font-medium text-defect">
        <Icon name="bug" size={11} /> App defect <span className="font-mono font-normal opacity-80">{verdict.confidence.toFixed(2)}</span>
      </span>
    );
  }
  return <span className="text-[12px] text-muted">Classifier: {VERDICT_WORDS[verdict.class] ?? verdict.class}, not filed as a defect</span>;
}

/**
 * The stored outcome of a rerun, drawn from the message so a reopened chat shows the same table.
 * `integration` is undefined while the page is still finding out whether a tracker is connected,
 * null when none is, so a row never flashes "Connect" before the answer is in.
 */
export function RerunResultTable({
  result, integration, tickets, filing, onRaise, connectHref = "/settings?return=%2Fcopilot",
}: {
  result: RerunResultData;
  integration: IntegrationPublic | null | undefined;
  /** Tickets already filed for this run, by test id. */
  tickets: Record<string, TicketRecord>;
  /** The test id being filed right now, or null. */
  filing: string | null;
  onRaise: (testId: string) => void;
  /** Where "Connect Linear or Jira" goes; the page adds the chat to return to. */
  connectHref?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-box border border-line bg-inset">
      <table className="w-full text-[13px]">
        <tbody>
          {result.results.map((r) => {
            const passed = r.status === "passed";
            const ticket = tickets[r.id];
            const showVerdict = !passed && (r.verdict !== undefined || ticket !== undefined);
            return (
              <tr key={r.id} className="border-b border-line last:border-b-0">
                <td className="w-5 py-2 pl-3 align-top">
                  <span className={passed ? "text-pass" : "text-fail"}><Icon name={passed ? "check" : "x"} size={12} /></span>
                </td>
                <td className="py-2 pr-3 align-top">
                  <Link href={`/runs/${encodeURIComponent(result.runId)}/cases?test=${encodeURIComponent(r.id)}`} className="font-mono text-fg hover:underline">{r.id}</Link>
                  <span className="ml-2 text-muted">{r.title}</span>
                  {r.error && <p className="mt-0.5 text-[12px] text-fail">{firstLine(r.error)}</p>}
                  {showVerdict && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <Verdict row={r} />
                      <TicketAction row={r} integration={integration} ticket={ticket} filing={filing === r.id} onRaise={() => onRaise(r.id)} connectHref={connectHref} />
                    </div>
                  )}
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
