"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon, LogoTile } from "@/components/ui";
import { createChat, deleteChat as deleteChatApi, getChat, listChats, sendChatMessage } from "@/lib/api";
import type { Chat, ChatMessage, ChatNeed, ChatSummary } from "@/lib/api";
import type { DraftPatch, RunDraft } from "@/lib/draft";
import { snapshotOf } from "@/lib/draft";
import { ChatsMenu } from "./ChatsMenu";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

const SUGGESTIONS = [
  { icon: "target" as const, text: "Test the mini-shop on http://localhost:3005, focusing on checkout" },
  { icon: "file" as const, text: "I have a PRD - plan the tests from it and tell me what it does not cover" },
  { icon: "bug" as const, text: "Cover the error states: bad card, empty cart, wrong password" },
];

export function ChatPanel({
  draft, chatId, onChatId, onPatch, onLoadDraft, onCredentials,
}: {
  draft: RunDraft;
  /** Owned by the page, which sends it with the run so history links the two. */
  chatId: string | null;
  onChatId: (id: string | null) => void;
  /** Applied to the form the moment a turn returns, so the fields fill in as you talk. */
  onPatch: (patch: DraftPatch) => void;
  /** Replaces the whole form when a saved chat is reopened. */
  onLoadDraft: (patch: DraftPatch) => void;
  /** Kept apart from `onPatch` on purpose: a credential is never part of a patch. */
  onCredentials: (next: { username: string; password: string }) => void;
}) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [needs, setNeeds] = useState<ChatNeed[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const refreshChats = useCallback(() => {
    listChats().then(setChats).catch(() => {});
  }, []);

  useEffect(refreshChats, [refreshChats]);

  const adopt = (chat: Chat) => {
    onChatId(chat.id);
    setMessages(chat.messages);
    setNeeds([]);
    setError(null);
    onLoadDraft(chat.draft);
  };

  /**
   * A chat row is created on the first message rather than on mount, so opening the screen
   * and starting a run without ever typing does not leave an empty conversation in history.
   */
  async function send(body: string, extra?: DraftPatch) {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    setText("");
    const at = new Date().toISOString();
    setMessages((prev) => prev.concat({ role: "user", text: trimmed, at }));

    try {
      const id = chatId ?? (await createChat()).id;
      if (!chatId) onChatId(id);
      // `extra` is the patch the browser itself made - an attached PRD - which the server
      // has not seen yet, so it rides along in this turn's snapshot.
      const turn = await sendChatMessage(id, trimmed, { ...snapshotOf(draft), ...(extra ?? {}) });
      setMessages((prev) => prev.concat({ role: "assistant", text: turn.reply, at: new Date().toISOString() }));
      setNeeds(turn.needs);
      onPatch(turn.patch);
      refreshChats();
    } catch (err) {
      // The typed message is put back rather than lost, so a failed turn costs a click.
      setMessages((prev) => prev.slice(0, -1));
      setText(trimmed);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: File) {
    try {
      const prdText = await file.text();
      onPatch({ prdText, prdName: file.name });
      await send(`Attached a PRD: ${file.name}`, { prdText, prdName: file.name });
    } catch {
      setError(`Could not read ${file.name}. Try pasting it into the form instead.`);
    }
  }

  async function open_(id: string) {
    try {
      adopt(await getChat(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function reset() {
    onChatId(null);
    setMessages([]);
    setNeeds([]);
    setError(null);
    setText("");
  }

  async function remove(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (id === chatId) reset();
    await deleteChatApi(id).catch(() => refreshChats());
  }

  if (!open) {
    return (
      <div className="sticky top-0 flex h-screen w-11 shrink-0 flex-col items-center self-start border-l border-line bg-app py-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the intake assistant"
          className="inline-flex h-8 w-8 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg"
        >
          <Icon name="chat" size={15} />
        </button>
        {messages.length > 0 && <span className="mt-2 h-1.5 w-1.5 rounded-full bg-info" title="This chat has history" />}
      </div>
    );
  }

  // self-start matters: without it the flex row stretches the panel to the height of the form
  // beside it, h-screen is overridden, and the sticky has no room to move in - the composer
  // then scrolls off the bottom as soon as the form is scrolled.
  return (
    <aside className="sticky top-0 flex h-screen w-[380px] shrink-0 flex-col self-start border-l border-line bg-app">
      <header className="flex h-[57px] shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <ChatsMenu
          chats={chats} currentId={chatId} open={menuOpen} onOpen={setMenuOpen}
          onSelect={open_} onNew={reset} onDelete={remove}
        />
        <div className="flex items-center gap-0.5">
          <button
            type="button" onClick={reset} aria-label="New chat"
            className="inline-flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button" onClick={() => setOpen(false)} aria-label="Collapse the intake assistant"
            className="inline-flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-selected hover:text-fg"
          >
            <Icon name="panelRight" size={14} />
          </button>
        </div>
      </header>

      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center overflow-y-auto px-4 py-6">
          <div className="text-center">
            <div className="flex justify-center"><LogoTile size={34} /></div>
            <p className="mt-4 text-[17px] font-medium tracking-[-0.1px] text-fg">What can I help you test?</p>
            <p className="mt-1 text-[12.5px] text-muted">Describe the app and the flows that matter.</p>
          </div>
          <div className="mt-6 space-y-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => void send(s.text)}
                className="flex w-full items-start gap-2.5 rounded-box border border-line bg-surface px-3 py-2.5 text-left text-[12.5px] leading-relaxed text-body transition-colors hover:border-line-strong hover:text-fg"
              >
                <Icon name={s.icon} size={13} className="mt-0.5 shrink-0 text-muted" />
                {s.text}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Transcript
          messages={messages} busy={busy} needs={needs}
          credentials={{ username: draft.username, password: draft.password }}
          onCredentials={onCredentials}
        />
      )}

      <div className="shrink-0 border-t border-line p-3">
        {/* Above the composer rather than inside the transcript, so a first turn that fails
            is still reported on a screen that has no transcript yet. */}
        {error && (
          <p role="alert" className="mb-2 flex items-start gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[12.5px] text-fail">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        <Composer
          value={text} onChange={setText} onSend={() => void send(text)}
          onAttach={(f) => void attach(f)} busy={busy}
        />
        <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-subtle">
          Fills the form on the left. You start the run.
        </p>
      </div>
    </aside>
  );
}
