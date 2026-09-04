"use client";
import { useState } from "react";
import { API, startRun, useRunEvents } from "@/lib/events";
import { Pipeline } from "./components/Pipeline";
import { Feed } from "./components/Feed";
import { Decisions } from "./components/Decisions";
import { Results } from "./components/Results";

export default function Home() {
  const [runId, setRunId] = useState<string | null>(null);
  const [form, setForm] = useState({ url: "http://localhost:3005", intent: "focus on auth and checkout", username: "demo@shop.test", password: "demo1234", prd: "" });
  const [error, setError] = useState<string | null>(null);
  const events = useRunEvents(runId);
  const done = events.some((e) => e.type === "done");
  const shot = [...events].reverse().find((e) => e.type === "screenshot") as { data?: { path: string } } | undefined;
  const shotUrl = shot?.data?.path && runId ? `${API}/runs/${runId}/files/${encodeURIComponent(shot.data.path.split(`/${runId}/`)[1] ?? "")}` : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try { setRunId(await startRun(form)); } catch (err) { setError((err as Error).message); }
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6 space-y-4">
      <h1 className="text-2xl font-semibold">qa-pilot</h1>
      <form onSubmit={submit} className="grid grid-cols-6 gap-2 text-sm">
        <input className="col-span-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://app.example.com" />
        <input className="col-span-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} placeholder="intent" />
        <input className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username" />
        <input className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="password" />
        <textarea className="col-span-5 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 h-16" value={form.prd} onChange={(e) => setForm({ ...form, prd: e.target.value })} placeholder="optional PRD text" />
        <button className="bg-amber-500 text-black rounded font-medium disabled:opacity-50" disabled={!!runId && !done}>Start</button>
      </form>
      {error && <div className="text-red-400 text-sm">{error}</div>}
      <Pipeline events={events} />
      <div className="grid grid-cols-3 gap-4">
        <section className="col-span-2 bg-neutral-900 rounded p-3"><h2 className="text-sm text-neutral-400 mb-1">Agent feed</h2><Feed events={events} /></section>
        <section className="bg-neutral-900 rounded p-3">
          <h2 className="text-sm text-neutral-400 mb-1">Browser</h2>
          {shotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shotUrl} alt="latest screenshot" className="rounded border border-neutral-700" />
          ) : (
            <div className="text-neutral-500 text-sm">waiting…</div>
          )}
        </section>
        <section className="col-span-2 bg-neutral-900 rounded p-3"><h2 className="text-sm text-neutral-400 mb-1">Decisions</h2><Decisions events={events} /></section>
        <section className="bg-neutral-900 rounded p-3"><h2 className="text-sm text-neutral-400 mb-1">Results</h2><Results events={events} /></section>
      </div>
      {done && runId && (
        <section className="bg-neutral-900 rounded p-3">
          <h2 className="text-sm text-neutral-400 mb-1">Report <a className="underline" href={`${API}/report/${runId}`} target="_blank">open</a></h2>
          <iframe title="report" src={`${API}/report/${runId}`} className="w-full h-[70vh] bg-white rounded" />
        </section>
      )}
    </main>
  );
}
