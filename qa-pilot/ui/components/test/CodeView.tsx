"use client";
import { Spinner } from "@/components/ui";
import { useArtifactText } from "@/lib/hooks";

/** The generated Playwright spec, verbatim: what the runner executed, heals included. */
export function CodeView({ runId, relPath, version }: { runId: string; relPath: string; version: number }) {
  const text = useArtifactText(runId, relPath, version);
  if (text === null) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (text === "") return <p className="p-4 text-sm text-muted">This test has not been generated yet.</p>;
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-auto rounded-box bg-console p-4 font-mono text-[12px] leading-relaxed">
      <table className="border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={/^\s*\/\/ step/.test(line) ? "text-neutral-500" : /^\s*await expect/.test(line) ? "text-emerald-300" : "text-neutral-200"}>
              <td className="select-none pr-4 text-right text-neutral-600">{i + 1}</td>
              <td className="whitespace-pre">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
