"use client";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";
import { CredentialsRow } from "@/components/chat/Transcript";
import type { ChatMessage, IntegrationPublic, RerunPlanData, TicketRecord } from "@/lib/api";
import type { LiveStatus } from "@/lib/copilot";
import { RerunPlanCard } from "./RerunPlanCard";
import { RerunResultTable } from "./RerunResultTable";

function Thinking() {
  return (
    <div className="flex items-center gap-1 py-1" role="status" aria-label="thinking">
      {[0, 150, 300].map((delay) => (
        <span key={delay} style={{ animationDelay: `${delay}ms` }} className="h-1.5 w-1.5 animate-pulse rounded-full bg-subtle" />
      ))}
    </div>
  );
}

export function CopilotTranscript({
  messages, busy, needsCredentials, credentials, onCredentials, onRunWithCredentials, live,
  integration, tickets, filing, onRaise, connectHref,
}: {
  messages: ChatMessage[];
  busy: boolean;
  needsCredentials: boolean;
  credentials: { username: string; password: string };
  onCredentials: (next: { username: string; password: string }) => void;
  onRunWithCredentials: () => void;
  /** The plan currently executing and each test's live status, or null when nothing is running. */
  live: { plan: RerunPlanData; statuses: Record<string, LiveStatus> } | null;
  /** The user's tracker connection: undefined while loading, null when none. */
  integration: IntegrationPublic | null | undefined;
  /** Tickets already filed, by run id then test id. */
  tickets: Record<string, Record<string, TicketRecord>>;
  /** The test being filed right now as "runId/testId", or null. */
  filing: string | null;
  onRaise: (runId: string, testId: string) => void;
  connectHref: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy, needsCredentials, live]);

  const ready = credentials.username.trim() && credentials.password;

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((m, i) => {
        if (m.role === "user") {
          return (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-box bg-raised px-3 py-2 text-[13.5px] leading-relaxed text-fg">{m.text}</p>
            </div>
          );
        }
        // Identity, not shape: the page hands down the very plan object it took from the
        // message, so only the message that started the rerun animates.
        const isLive = live !== null && m.data?.kind === "rerun_plan" && m.data === live.plan;
        return (
          <div key={i} className="space-y-2 px-1">
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-body">{m.text}</p>
            {m.data?.kind === "rerun_plan" && <RerunPlanCard plan={m.data} statuses={isLive ? live.statuses : null} live={isLive} />}
            {m.data?.kind === "rerun_result" && (
              <RerunResultTable
                result={m.data} integration={integration} tickets={tickets[m.data.runId] ?? {}}
                filing={filing?.startsWith(`${m.data.runId}/`) ? filing.slice(m.data.runId.length + 1) : null}
                onRaise={(testId) => onRaise(m.data!.runId, testId)} connectHref={connectHref}
              />
            )}
          </div>
        );
      })}

      {busy && <Thinking />}

      {!busy && needsCredentials && (
        <div className="space-y-2">
          <CredentialsRow username={credentials.username} password={credentials.password} onChange={onCredentials} />
          <Button size="sm" onClick={onRunWithCredentials} disabled={!ready}>Run with these credentials</Button>
        </div>
      )}

      <div ref={end} />
    </div>
  );
}
