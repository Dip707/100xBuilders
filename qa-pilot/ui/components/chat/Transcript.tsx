"use client";
import { useEffect, useRef } from "react";
import { Icon, Input } from "@/components/ui";
import type { ChatMessage, ChatNeed } from "@/lib/api";

/** The three dots while a turn is in flight. A turn is a second or two, so this is all it needs. */
function Thinking() {
  return (
    <div className="flex items-center gap-1 py-1" role="status" aria-label="thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: `${delay}ms` }}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-subtle"
        />
      ))}
    </div>
  );
}

/**
 * The sign-in row, rendered inside the transcript when a turn says it needs credentials.
 *
 * It looks like part of the conversation but is not: what gets typed here goes straight into
 * the page's own state and travels only with the run itself. It is never in a message, never
 * in the snapshot the assistant sees, and never in the stored transcript - which is why the
 * assistant asks for the account but cannot be the one to hold it.
 */
export function CredentialsRow({
  username, password, onChange,
}: { username: string; password: string; onChange: (next: { username: string; password: string }) => void }) {
  return (
    <div className="rounded-box border border-line bg-inset p-3">
      <p className="flex items-center gap-1.5 text-[12px] text-muted">
        <Icon name="ban" size={12} /> Typed here, sent only with the run. Never stored, never shown to the model.
      </p>
      <div className="mt-2.5 space-y-2">
        <Input
          value={username}
          onChange={(e) => onChange({ username: e.target.value, password })}
          placeholder="username or email"
          autoComplete="off"
          aria-label="Target app username"
          className="h-8 text-[13px]"
        />
        <Input
          value={password}
          onChange={(e) => onChange({ username, password: e.target.value })}
          type="password"
          placeholder="password"
          autoComplete="off"
          aria-label="Target app password"
          className="h-8 text-[13px]"
        />
      </div>
    </div>
  );
}

export function Transcript({
  messages, busy, needs, credentials, onCredentials,
}: {
  messages: ChatMessage[];
  busy: boolean;
  needs: ChatNeed[];
  credentials: { username: string; password: string };
  onCredentials: (next: { username: string; password: string }) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy, needs.length]);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div key={i} className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-box bg-raised px-3 py-2 text-[13.5px] leading-relaxed text-fg">
              {m.text}
            </p>
          </div>
        ) : (
          <p key={i} className="whitespace-pre-wrap px-1 text-[13.5px] leading-relaxed text-body">
            {m.text}
          </p>
        ),
      )}

      {busy && <Thinking />}

      {!busy && needs.includes("credentials") && (
        <CredentialsRow username={credentials.username} password={credentials.password} onChange={onCredentials} />
      )}

      <div ref={end} />
    </div>
  );
}
