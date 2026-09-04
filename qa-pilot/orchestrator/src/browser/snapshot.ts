import type { ElementRef } from "../state.js";

export type SnapshotNode = { role: string; name: string; depth: number; line: string };

const LINE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]]*\])?:?/;

export function parseSnapshot(yaml: string): SnapshotNode[] {
  const out: SnapshotNode[] = [];
  for (const raw of yaml.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    out.push({ role: m[2], name: (m[3] ?? "").replace(/\\"/g, '"'), depth: m[1].length / 2, line: raw.trim() });
  }
  return out;
}

// Character bigrams rather than whole-word tokens: two names built from entirely different
// words (e.g. "Place order" vs "Complete purchase") should still separate by how much of their
// spelling overlaps, instead of tying at zero the way word-level tokens would.
const bigrams = (s: string): Set<string> => {
  const t = s.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (out.size === 0 && t.length > 0) out.add(t);
  return out;
};

export function nameSimilarity(a: string, b: string): number {
  const ta = bigrams(a), tb = bigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const prefix = a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()) ? 0.3 : 0;
  return Math.min(1, jaccard + prefix);
}

export function findNearTwins(nodes: SnapshotNode[], ref: ElementRef): { node: SnapshotNode; similarity: number }[] {
  return nodes
    .filter((n) => n.role === ref.role && n.name)
    .map((node) => ({ node, similarity: nameSimilarity(node.name, ref.name) }))
    .sort((a, b) => b.similarity - a.similarity);
}
