import type { RunEvent } from "@/lib/events";

const BADGE: Record<string, string> = { script: "bg-emerald-700", defect: "bg-red-700", flaky: "bg-amber-600", env: "bg-neutral-600", needs_human: "bg-violet-700" };

export function Results({ events }: { events: RunEvent[] }) {
  const tests = new Map<string, { status: string; cls?: string; conf?: number }>();
  for (const e of events) {
    if (e.type !== "test_result") continue;
    const d = e.data as { id?: string; status?: string; test?: string; class?: string; confidence?: number };
    if (d.id && d.status) tests.set(d.id, { ...(tests.get(d.id) ?? { status: d.status }), status: d.status });
    if (d.test && d.class) tests.set(d.test, { ...(tests.get(d.test) ?? { status: "failed" }), cls: d.class, conf: d.confidence });
  }
  const all = [...tests.entries()];
  const passed = all.filter(([, t]) => t.status === "passed").length;
  return (
    <div>
      <div className="flex gap-4 text-2xl mb-2"><span className="text-emerald-400">{passed} pass</span><span className="text-red-400">{all.length - passed} fail</span></div>
      <ul className="text-sm space-y-1 max-h-56 overflow-auto">
        {all.map(([id, t]) => (
          <li key={id} className="flex gap-2 items-center">
            <span className={t.status === "passed" ? "text-emerald-400" : "text-red-400"}>●</span>
            <span className="font-mono">{id}</span>
            {t.cls && <span className={`px-2 rounded text-xs ${BADGE[t.cls] ?? ""}`}>{t.cls} {t.conf?.toFixed(2)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
