"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, CardRow, Checkbox, Field, Input, Segmented, Spinner, Textarea } from "@/components/ui";
import { startRun } from "@/lib/api";

const DEFAULTS = {
  url: "http://localhost:3005",
  intent: "focus on auth and checkout",
  username: "demo@shop.test",
  password: "demo1234",
};

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export default function NewRunPage() {
  const router = useRouter();
  const [url, setUrl] = useState(DEFAULTS.url);
  const [intent, setIntent] = useState(DEFAULTS.intent);
  const [requiresSignIn, setRequiresSignIn] = useState(true);
  const [username, setUsername] = useState(DEFAULTS.username);
  const [password, setPassword] = useState(DEFAULTS.password);
  const [prdMode, setPrdMode] = useState<"upload" | "paste">("upload");
  const [prd, setPrd] = useState("");
  const [prdName, setPrdName] = useState<string | null>(null);
  const [reviewPlan, setReviewPlan] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [maxFlows, setMaxFlows] = useState(12);
  const [maxLlmCalls, setMaxLlmCalls] = useState(200);
  const [maxMinutes, setMaxMinutes] = useState(40);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function readPrdFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      setPrd(text);
      setPrdName(file.name);
    } catch {
      setPrdName(null);
      setError(`Could not read ${file.name}. Try again or paste the PRD instead.`);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const runId = await startRun({
        url,
        intent: intent.trim() || undefined,
        prd: prd.trim() || undefined,
        credentials: requiresSignIn && username && password ? { username, password } : undefined,
        maxFlows,
        budget: { maxLlmCalls, maxMinutes },
        reviewPlan,
      });
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-screen flex-col">
      <PageHeader
        crumbs={[{ label: "Runs", href: "/" }, { label: "New run" }]}
        title="Start a run"
        subtitle="Tell qa-pilot what to test. It explores the app, writes a plan, scores the plan for gaps, generates Playwright tests, runs them, and repairs what breaks."
      />

      <div className="mx-auto w-full max-w-[1040px] flex-1 space-y-6 px-8 pb-32 pt-4">
        <Card title="Target">
          <CardRow>
            <Field label="URL" required help="The URL of the app qa-pilot should test.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com" required />
            </Field>
          </CardRow>
          <CardRow>
            <Field label="Intent" help="Natural-language scoping, for example: focus on auth and checkout. Leave blank to let the planner cover the whole app.">
              <Input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="focus on auth and checkout" />
            </Field>
          </CardRow>
        </Card>

        <Card title="Sign in to the target app">
          <CardRow>
            <div className="space-y-4 py-5">
              <Checkbox
                checked={requiresSignIn} onChange={setRequiresSignIn} label="Require sign in?"
                help="Check this if parts of the app are behind a login. qa-pilot signs in with a test account so it can reach those flows. These credentials are used for the run and are never stored."
              />
              {requiresSignIn && (
                <div className="grid gap-3 pl-[30px] sm:grid-cols-2">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoComplete="off" aria-label="Target app username" />
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password" autoComplete="off" aria-label="Target app password" />
                </div>
              )}
            </div>
          </CardRow>
        </Card>

        <Card title="Add sources">
          <CardRow>
            <Field label="Add sources" help="qa-pilot extracts requirements from the document and maps each one onto a planned flow, then reports the ones nothing covers.">
              <div className="space-y-3">
                <div className="rounded-box border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-[15px] font-semibold text-fg">Product Requirements Doc (PRD)</p>
                      <p className="text-[13px] text-accent">✦ Strongly recommended</p>
                    </div>
                    <Segmented
                      options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste" }]}
                      value={prdMode} onChange={setPrdMode}
                    />
                  </div>

                  <div className="mt-4">
                    {prdMode === "upload" ? (
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-inset">
                        <span aria-hidden="true">↥</span>
                        {prdName ?? "Upload PRD"}
                        <input
                          type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" className="sr-only"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPrdFile(f); }}
                        />
                      </label>
                    ) : (
                      <Textarea
                        value={prd} onChange={(e) => { setPrd(e.target.value); setPrdName(null); }}
                        className="h-32" placeholder="Paste the requirements here"
                      />
                    )}
                  </div>
                </div>
              </div>
            </Field>
          </CardRow>
        </Card>

        <Card title="Review">
          <CardRow>
            <div className="py-5">
              <Checkbox
                checked={reviewPlan} onChange={setReviewPlan} label="Review the plan before tests are generated?"
                help="Pauses the run once the plan has passed the coverage gate so you can rename, re-prioritise or drop proposed tests. Leave it off for a fully autonomous run."
              />
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
                  <Input type="number" min={1} value={maxFlows} onChange={(e) => setMaxFlows(Number(e.target.value))} />
                </Field>
              </CardRow>
              <CardRow>
                <Field label="Max LLM calls" help="The run stops and reports partially once this is exceeded.">
                  <Input type="number" min={1} value={maxLlmCalls} onChange={(e) => setMaxLlmCalls(Number(e.target.value))} />
                </Field>
              </CardRow>
              <CardRow>
                <Field label="Max minutes" help="Wall-clock budget for the whole run.">
                  <Input type="number" min={1} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
                </Field>
              </CardRow>
            </>
          ) : (
            <p className="py-5 text-[13px] text-muted">
              {maxFlows} flows, {maxLlmCalls} LLM calls, {maxMinutes} minutes.
            </p>
          )}
        </Card>
      </div>

      {/* Sticky action bar, as in the reference: the primary stays disabled until the URL parses. */}
      <div className="sticky bottom-0 border-t border-line bg-surface/95 px-8 py-4 backdrop-blur">
        {error && <p role="alert" className="mx-auto mb-3 max-w-[1040px] rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}
        <div className="flex justify-center gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/")}>Cancel</Button>
          <Button type="submit" disabled={busy || !isValidUrl(url)}>
            {busy ? <><Spinner /> starting</> : "Start run"}
          </Button>
        </div>
      </div>
    </form>
  );
}
