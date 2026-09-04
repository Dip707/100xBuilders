"use client";
import { Spinner } from "@/components/ui";
import { useArtifactText } from "@/lib/hooks";

/** The generated Playwright spec, verbatim: what the runner executed, heals included. */
export function CodeView({ runId, relPath, version }: { runId: string; relPath: string; version: number }) {
  const text = useArtifactText(runId, relPath, version);
  if (text === null) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (text === "") return <p className="p-4 text-[13px] text-muted">This test has not been generated yet.</p>;
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-auto rounded-box border border-line bg-console p-4 font-mono text-[11.5px] leading-[1.7]">
      <table className="border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={/^\s*\/\/ step/.test(line) ? "text-[#6a6b6c]" : /^\s*await expect/.test(line) ? "text-[#59d499]" : "text-[#cdcdcd]"}>
              <td className="select-none pr-4 text-right text-[#434345]">{i + 1}</td>
              <td className="whitespace-pre">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
