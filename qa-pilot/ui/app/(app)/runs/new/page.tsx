"use client";
import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, CardRow, Checkbox, Field, Flash, Icon, Input, Segmented, Spinner, Textarea, Wallpaper } from "@/components/ui";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { startRun } from "@/lib/api";
import { DEFAULT_DRAFT, formReducer, isValidUrl, runInputFromDraft, type DraftField, type RunDraft } from "@/lib/draft";

/** How long a field the assistant wrote stays ringed. Long enough to catch, short enough to ignore. */
const FLASH_MS = 1600;

export default function NewRunPage() {
  const router = useRouter();
  const [{ draft, flash }, dispatch] = useReducer(formReducer, { draft: DEFAULT_DRAFT, flash: [] });
  const [chatId, setChatId] = useState<string | null>(null);
  const [prdMode, setPrdMode] = useState<"upload" | "paste">("upload");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lit = (field: DraftField) => flash.includes(field);
  const edit = (fields: Partial<RunDraft>) => dispatch({ kind: "edit", fields });

  useEffect(() => {
    if (flash.length === 0) return;
    const timer = setTimeout(() => dispatch({ kind: "clearFlash" }), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  async function readPrdFile(file: File) {
    setError(null);
    try {
      edit({ prdText: await file.text(), prdName: file.name });
    } catch {
      edit({ prdName: "" });
      setError(`Could not read ${file.name}. Try again or paste the PRD instead.`);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const runId = await startRun(runInputFromDraft(draft, chatId ?? undefined));
      // A fresh run has nothing but its crawl, so it opens on Sources - the stage that is
      // actually running - rather than on a Test Runs screen with an empty table.
      router.push(`/runs/${encodeURIComponent(runId)}/sources`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <form onSubmit={submit} className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Wallpaper name="prism" />
        <PageHeader
          crumbs={[{ label: "Runs", href: "/" }, { label: "New run" }]}
          title="Start a run"
          subtitle="Tell qa-pilot what to test, in the form or in the chat. It explores the app, writes a plan, scores the plan for gaps, generates Playwright tests, runs them, and repairs what breaks."
        />

        <div className="mx-auto w-full max-w-[960px] flex-1 space-y-4 px-6 pb-32 pt-5">
          <Card title="Target">
            <CardRow>
              <Field label="URL" required help="The URL of the app qa-pilot should test.">
                <Flash on={lit("url")}>
                  <Input value={draft.url} onChange={(e) => edit({ url: e.target.value })} placeholder="https://app.example.com" required />
                </Flash>
              </Field>
            </CardRow>
            <CardRow>
              <Field label="Intent" help="Natural-language scoping, for example: focus on auth and checkout. Leave blank to let the planner cover the whole app.">
                <Flash on={lit("intent")}>
                  <Input value={draft.intent} onChange={(e) => edit({ intent: e.target.value })} placeholder="focus on auth and checkout" />
                </Flash>
              </Field>
            </CardRow>
          </Card>

          <Card title="Sign in to the target app">
            <CardRow>
              <div className="space-y-4 py-4">
                <Flash on={lit("requiresSignIn")} className="-m-1 p-1">
                  <Checkbox
                    checked={draft.requiresSignIn} onChange={(v) => edit({ requiresSignIn: v })} label="Require sign in?"
                    help="Check this if parts of the app are behind a login. qa-pilot signs in with a test account so it can reach those flows. These credentials are used for the run and are never stored."
                  />
                </Flash>
                {draft.requiresSignIn && (
                  <div className="grid gap-2.5 pl-7 sm:grid-cols-2">
                    <Input value={draft.username} onChange={(e) => edit({ username: e.target.value })} placeholder="username or email" autoComplete="off" aria-label="Target app username" />
                    <Input value={draft.password} onChange={(e) => edit({ password: e.target.value })} type="password" placeholder="password" autoComplete="off" aria-label="Target app password" />
                  </div>
                )}
              </div>
            </CardRow>
          </Card>

          <Card title="Add sources">
            <CardRow>
              <Field label="Add sources" help="qa-pilot extracts requirements from the document and maps each one onto a planned flow, then reports the ones nothing covers.">
                <div className="space-y-3">
                  <Flash on={lit("prd")}>
                    <div className="rounded-box border border-line bg-inset p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-[13.5px] font-medium tracking-[0.2px] text-fg">Product Requirements Doc (PRD)</p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                            <Icon name="sparkles" size={12} /> Strongly recommended
                          </p>
                        </div>
                        <Segmented
                          options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste" }]}
                          value={prdMode} onChange={setPrdMode}
                        />
                      </div>

                      <div className="mt-4">
                        {prdMode === "upload" ? (
                          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-input border border-line-strong px-3.5 text-sm font-medium tracking-[0.2px] text-fg transition-colors hover:bg-selected">
                            <Icon name="download" size={13} className="rotate-180" />
                            {draft.prdName || "Upload PRD"}
                            <input
                              type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" className="sr-only"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPrdFile(f); }}
                            />
                          </label>
                        ) : (
                          <Textarea
                            value={draft.prdText} onChange={(e) => edit({ prdText: e.target.value, prdName: "" })}
                            className="h-32" placeholder="Paste the requirements here"
                          />
                        )}
                      </div>
                    </div>
                  </Flash>
                </div>
              </Field>
            </CardRow>
          </Card>

          <Card title="Review">
            <CardRow>
              <div className="py-4">
                <Flash on={lit("reviewPlan")} className="-m-1 p-1">
                  <Checkbox
                    checked={draft.reviewPlan} onChange={(v) => edit({ reviewPlan: v })} label="Review the plan before tests are generated?"
                    help="Pauses the run once the plan has passed the coverage gate so you can rename, re-prioritise or drop proposed tests. Leave it off for a fully autonomous run."
                  />
                </Flash>
              </div>
            </CardRow>
          </Card>

          <Card
            title="Budget"
            actions={
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
                {advanced ? "Hide" : "Show"} advanced
              </Button>
            }
          >
            {advanced ? (
              <>
                <CardRow>
                  <Field label="Max flows" help="Upper bound on how many flows the planner may produce.">
                    <Flash on={lit("maxFlows")}>
                      <Input type="number" min={1} value={draft.maxFlows} onChange={(e) => edit({ maxFlows: Number(e.target.value) })} />
                    </Flash>
                  </Field>
                </CardRow>
                <CardRow>
                  <Field label="Max LLM calls" help="The run stops and reports partially once this is exceeded.">
                    <Flash on={lit("budget")}>
                      <Input type="number" min={1} value={draft.budget.maxLlmCalls} onChange={(e) => edit({ budget: { ...draft.budget, maxLlmCalls: Number(e.target.value) } })} />
                    </Flash>
                  </Field>
                </CardRow>
                <CardRow>
                  <Field label="Max minutes" help="Wall-clock budget for the whole run.">
                    <Flash on={lit("budget")}>
                      <Input type="number" min={1} value={draft.budget.maxMinutes} onChange={(e) => edit({ budget: { ...draft.budget, maxMinutes: Number(e.target.value) } })} />
                    </Flash>
                  </Field>
                </CardRow>
              </>
            ) : (
              <p className="py-4 text-[13px] text-muted">
                <span className={`font-mono ${lit("maxFlows") ? "text-info" : "text-fg"}`}>{draft.maxFlows}</span> flows,{" "}
                <span className={`font-mono ${lit("budget") ? "text-info" : "text-fg"}`}>{draft.budget.maxLlmCalls}</span> LLM calls,{" "}
                <span className={`font-mono ${lit("budget") ? "text-info" : "text-fg"}`}>{draft.budget.maxMinutes}</span> minutes.
              </p>
            )}
          </Card>
        </div>

        {/* Sticky action bar. The primary stays disabled until the URL parses, so the bar is
            also the validity readout - and the one place a run can be started from. */}
        <div className="sticky bottom-0 z-20 border-t border-line bg-surface/90 px-6 py-3.5 backdrop-blur-md">
          {error && (
            <p role="alert" className="mx-auto mb-3 flex max-w-[960px] items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
              <Icon name="alert" size={14} /> {error}
            </p>
          )}
          <div className="mx-auto flex max-w-[960px] items-center justify-between gap-3">
            <p className="hidden text-[12.5px] text-muted sm:block">
              {isValidUrl(draft.url) ? "Ready. qa-pilot will explore, plan, generate and run." : "Enter a valid http(s) URL to continue."}
            </p>
            <div className="flex flex-1 justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.push("/")}>Cancel</Button>
              <Button type="submit" disabled={busy || !isValidUrl(draft.url)}>
                {busy ? <><Spinner /> starting</> : "Start run"}
              </Button>
            </div>
          </div>
        </div>
      </form>

      {/*
        Outside the form on purpose: the composer's Enter key and the panel's buttons must
        never be able to submit a run. Only the action bar above starts one.
      */}
      <ChatPanel
        draft={draft}
        chatId={chatId}
        onChatId={setChatId}
        onPatch={(patch) => dispatch({ kind: "patch", patch })}
        onLoadDraft={(patch) => dispatch({ kind: "load", patch })}
        onCredentials={(next) => edit(next)}
      />
    </div>
  );
}
