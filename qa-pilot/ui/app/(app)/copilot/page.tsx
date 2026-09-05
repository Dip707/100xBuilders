"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Icon, Wallpaper } from "@/components/ui";
import { ChatsMenu } from "@/components/chat/ChatsMenu";
import { Composer } from "@/components/chat/Composer";
import { CopilotTranscript } from "@/components/copilot/CopilotTranscript";
import {
  createCopilotChat, deleteChat as deleteChatApi, executeCopilot, getChat, listCopilotChats, sendCopilotMessage,
  type Chat, type ChatMessage, type ChatScope, type ChatSummary, type RerunPlanData,
} from "@/lib/api";
import { useRunEvents } from "@/lib/events";
import { isSettled, liveStatuses, pendingPlan } from "@/lib/copilot";

const SUGGESTIONS = [
  { icon: "refresh" as const, text: "Rerun everything that failed in the last run" },
  { icon: "bug" as const, text: "Why did the checkout tests fail?" },
  { icon: "ban" as const, text: "What is still blocked, and is it a script bug or an app defect?" },
];

const EMPTY_CREDENTIALS = { username: "", password: "" };

/**
 * The copilot: a chat that acts on finished runs. A turn is two calls - the decision, then
 * the execution - so the person sees what is about to run before it runs. While it runs the
 * screen listens to the run's own event stream and moves each test's status in the plan card.
 */
export default function CopilotPage() {
  const params = useSearchParams();
  const scopeFromUrl = useMemo<ChatScope>(() => {
    const run = params.get("run");
    return run ? { runId: run } : {};
  }, [params]);

  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [credentials, setCredentials] = useState(EMPTY_CREDENTIALS);
  const [running, setRunning] = useState<{ plan: RerunPlanData; at: string } | null>(null);

  const refreshChats = useCallback(() => {
    listCopilotChats().then(setChats).catch(() => {});
  }, []);
  useEffect(refreshChats, [refreshChats]);

  // The run's event stream, only while a rerun is executing.
  const events = useRunEvents(running?.plan.runId ?? null);
  const statuses = useMemo(() => (running ? liveStatuses(running.plan, events, running.at) : null), [running, events]);
  const live = running && statuses ? { plan: running.plan, statuses } : null;

  const adopt = (chat: Chat) => {
    setChatId(chat.id);
    setMessages(chat.messages);
    setError(null);
    setNeedsCredentials(false);
    setCredentials(EMPTY_CREDENTIALS);
    // A chat reopened mid-rerun resumes watching the same plan.
    setRunning(chat.pending ? pendingPlan(chat.messages) : null);
  };

  async function run(id: string, plan: RerunPlanData, at: string, creds?: { username: string; password: string }) {
    setRunning({ plan, at });
    setNeedsCredentials(false);
    try {
      const done = await executeCopilot(id, creds);
      setMessages((prev) => prev.concat({ role: "assistant", text: done.reply, at: new Date().toISOString(), data: done.result }));
    } catch (err) {
      const message = (err as Error).message;
      // The server says exactly this when the tests sign in and it has no credentials.
      if (/sign in/.test(message)) setNeedsCredentials(true);
      else setError(message);
    } finally {
      setRunning(null);
      setCredentials(EMPTY_CREDENTIALS);
      refreshChats();
    }
  }

  async function send(body: string) {
    const trimmed = body.trim();
    if (!trimmed || busy || running) return;
    setError(null);
    setBusy(true);
    setText("");
    setNeedsCredentials(false);
    const at = new Date().toISOString();
    setMessages((prev) => prev.concat({ role: "user", text: trimmed, at }));
    try {
      const id = chatId ?? (await createCopilotChat(scopeFromUrl)).id;
      if (!chatId) setChatId(id);
      const turn = await sendCopilotMessage(id, trimmed);
      const assistantAt = new Date().toISOString();
      setMessages((prev) => prev.concat({ role: "assistant", text: turn.reply, at: assistantAt, ...(turn.plan ? { data: turn.plan } : {}) }));
      refreshChats();
      setBusy(false);
      if (turn.plan) {
        if (turn.needs.includes("credentials")) setNeedsCredentials(true);
        else await run(id, turn.plan, assistantAt);
      }
    } catch (err) {
      // The typed message is put back rather than lost, so a failed turn costs a click.
      setMessages((prev) => prev.slice(0, -1));
      setText(trimmed);
      setError((err as Error).message);
      setBusy(false);
    }
  }

  function runWithCredentials() {
    const pending = pendingPlan(messages);
    if (!chatId || !pending) return;
    void run(chatId, pending.plan, pending.at, credentials);
  }

  async function open_(id: string) {
    try {
      adopt(await getChat(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function reset() {
    setChatId(null);
    setMessages([]);
    setError(null);
    setText("");
    setNeedsCredentials(false);
    setCredentials(EMPTY_CREDENTIALS);
    setRunning(null);
  }

  async function remove(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (id === chatId) reset();
    await deleteChatApi(id).catch(() => refreshChats());
  }

  const settled = statuses ? isSettled(statuses) : true;

  return (
    <div className="flex min-h-screen flex-col">
      <Wallpaper name="prism" />
      <PageHeader
        crumbs={[{ label: "Runs", href: "/" }, { label: "Copilot" }]}
        title="Copilot"
        subtitle="Ask about a finished run, or tell it what to run again. It finds the run, checks the tests exist, reruns them and reports here."
        actions={
          <ChatsMenu chats={chats} currentId={chatId} open={menuOpen} onOpen={setMenuOpen} onSelect={open_} onNew={reset} onDelete={remove} />
        }
      />

      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-6 pb-6">
        {messages.length === 0 && !busy ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
            <p className="text-[13.5px] text-muted">
              {scopeFromUrl.runId ? <>Scoped to run <span className="font-mono text-fg">{scopeFromUrl.runId}</span>.</> : "Scoped to your most recent finished run unless you name one."}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text} type="button" onClick={() => void send(s.text)}
                  className="inline-flex items-center gap-1.5 rounded-input border border-line bg-inset px-3 py-1.5 text-[13px] text-body transition-colors hover:bg-selected hover:text-fg"
                >
                  <Icon name={s.icon} size={13} className="text-muted" /> {s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <CopilotTranscript
            messages={messages} busy={busy} needsCredentials={needsCredentials}
            credentials={credentials} onCredentials={setCredentials} onRunWithCredentials={runWithCredentials}
            live={live}
          />
        )}

        {error && (
          <p role="alert" className="mb-2 flex items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}

        <Composer
          value={text} onChange={setText} onSend={() => void send(text)}
          busy={busy || (running !== null && !settled)}
          placeholder={running ? "Waiting for the rerun to finish" : "Rerun the tests that failed last time, especially checkout"}
          ariaLabel="Message the copilot"
        />
      </div>
    </div>
  );
}
