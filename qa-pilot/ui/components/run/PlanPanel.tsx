"use client";
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/api";
import { Spinner } from "@/components/ui";

/** Renders the generated plan.md as text. It is markdown, but showing it verbatim keeps the flow ids, categories and priorities aligned. */
export function PlanPanel({ runId, available }: { runId: string; available: boolean }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    fetch(fileUrl(runId, "plan.md"), { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("plan not available"))))
      .then((t) => { if (!cancelled) setText(t); })
      .catch(() => { if (!cancelled) setText(null); });
    return () => { cancelled = true; };
  }, [runId, available]);

  if (!available) return <p className="p-4 text-[13px] text-muted">The planner has not written a plan yet.</p>;
  if (text === null) return <div className="flex justify-center p-8"><Spinner /></div>;
  return <pre className="h-full overflow-auto whitespace-pre-wrap rounded-box border border-line bg-inset p-4 font-mono text-[11.5px] leading-[1.7] text-body">{text}</pre>;
}
