"use client";
import { useMemo } from "react";
import { areaOf, groupByUseCase, type CaseRow, type CaseStatus } from "@/lib/cases";
import type { CoverageIteration } from "@/lib/hooks";

/*
 * A node graph of the plan, as in the reference: one lane per use case with the use-case
 * node on the left fanning out to its tests, and the coverage gaps the evaluator still
 * sees drawn as dashed nodes in the same lane so the gap sits next to the flows that
 * should have closed it. Pure SVG with elbow connectors; the geometry is simple enough
 * that a layout library would cost more than it gives.
 */

type GapNode = { kind: string; text: string; suggest: string; count: number };
type Lane = { useCase: string; rows: CaseRow[]; gaps: GapNode[]; risk: number };

const LANE_PAD = 24;
const ROW_H = 58;
const NODE_W = 320;
const NODE_H = 44;
const CASE_W = 250;
const CASE_H = 72;
const LANE_GAP = 28;
const LEFT = 40;
const TRUNK_X = LEFT + CASE_W + 44;
const NODE_X = TRUNK_X + 44;
const WIDTH = NODE_X + NODE_W + 60;

const STATUS_STROKE: Record<CaseStatus, string> = {
  planned: "var(--color-line-strong)", running: "var(--color-info)", passed: "var(--color-pass)", failed: "var(--color-fail)", blocked: "var(--color-flaky)",
};
const STATUS_GLYPH: Record<CaseStatus, string> = { planned: "◌", running: "⧗", passed: "✓", failed: "✕", blocked: "◑" };

/** Which lane a gap belongs to, from the path or keyword the evaluator named. */
function laneOfGap(g: CoverageIteration["gaps"][number]): string {
  if (g.requirement) return "PRD requirements";
  const target = (g.target ?? "").replace(/^form:/, "").replace(/^\//, "");
  const key = target.split("/")[0]?.split("?")[0] ?? "";
  if (!key) return "Plan mix";
  return areaOf(key);
}

function gapText(g: CoverageIteration["gaps"][number]): string {
  const target = g.target ?? g.requirement ?? "";
  switch (g.kind) {
    case "missing_happy": return `No happy path for ${target.replace(/^form:/, "")}`;
    case "missing_negative": return `No negative case for ${target.replace(/^form:/, "")}`;
    case "missing_empty_submit": return `No empty-submit case for ${target.replace(/^form:/, "")}`;
    case "missing_authz": return `No access-control check for ${target}`;
    case "prd_uncovered": return `PRD: ${target}`;
    case "intent_uncovered": return `Intent "${target}" has no flow`;
    case "category_mix": return "Too few negative and edge flows";
    default: return g.suggest;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function buildLanes(rows: CaseRow[], coverage: CoverageIteration | null): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const g of groupByUseCase(rows)) lanes.set(g.useCase, { useCase: g.useCase, rows: g.rows, gaps: [], risk: 0 });
  // Two forms on one page produce two identical gaps; one node with a count reads better than twins.
  const seen = new Map<string, GapNode>();
  for (const g of coverage?.gaps ?? []) {
    const name = laneOfGap(g);
    if (!lanes.has(name)) lanes.set(name, { useCase: name, rows: [], gaps: [], risk: 0 });
    const key = `${name}|${g.kind}|${g.target ?? g.requirement ?? ""}`;
    const existing = seen.get(key);
    if (existing) { existing.count++; existing.text = `${gapText(g)} (×${existing.count})`; continue; }
    const node: GapNode = { kind: g.kind, text: gapText(g), suggest: g.suggest, count: 1 };
    seen.set(key, node);
    lanes.get(name)!.gaps.push(node);
  }
  for (const r of coverage?.untested_risk ?? []) {
    const name = areaOf(r.flow.replace(/^\//, "").split("/")[0] ?? "");
    if (lanes.has(name)) lanes.get(name)!.risk++;
  }
  return [...lanes.values()];
}

/** Stacks the lanes top to bottom, each as tall as its items need. A plain reduce so nothing is reassigned during render. */
function placeLanes(lanes: Lane[]): { placed: Array<{ lane: Lane; top: number; h: number }>; height: number } {
  return lanes.reduce(
    (acc, lane) => {
      const items = Math.max(1, lane.rows.length + lane.gaps.length);
      const h = LANE_PAD * 2 + items * ROW_H + 30;
      return { placed: [...acc.placed, { lane, top: acc.height, h }], height: acc.height + h + LANE_GAP };
    },
    { placed: [] as Array<{ lane: Lane; top: number; h: number }>, height: 20 },
  );
}

export function CoverageGraph({ rows, coverage, onSelect, highlight }: { rows: CaseRow[]; coverage: CoverageIteration | null; onSelect: (id: string) => void; highlight?: string | null }) {
  const { placed, height } = useMemo(() => placeLanes(buildLanes(rows, coverage)), [rows, coverage]);

  if (placed.length === 0) return <p className="p-8 text-center text-sm text-muted">The planner has not produced any flows yet.</p>;

  return (
    <div className="overflow-auto rounded-card border border-line bg-app bg-[radial-gradient(var(--color-line)_1px,transparent_1px)] [background-size:20px_20px]">
      <svg width={WIDTH} height={height} role="img" aria-label="Test coverage graph" className="block font-sans">
        {placed.map(({ lane, top, h }) => {
          const caseY = top + h / 2 - CASE_H / 2 - 12;
          const centerY = caseY + CASE_H / 2;
          const items: Array<{ kind: "test"; row: CaseRow } | { kind: "gap"; gap: GapNode }> = [
            ...lane.rows.map((row) => ({ kind: "test" as const, row })),
            ...lane.gaps.map((gap) => ({ kind: "gap" as const, gap })),
          ];
          const firstY = top + LANE_PAD + 12;
          const isHighlighted = highlight === lane.useCase;
          return (
            <g key={lane.useCase} id={`lane-${lane.useCase.replace(/\s+/g, "-").toLowerCase()}`}>
              <text x={LEFT} y={top - 6} fontSize={12} fill="var(--color-muted)">{lane.useCase}</text>
              <rect x={LEFT - 16} y={top} width={WIDTH - LEFT * 2 + 16} height={h} rx={12} fill="var(--color-surface)" fillOpacity={0.75} stroke={isHighlighted ? "var(--color-fg)" : "var(--color-line)"} strokeWidth={isHighlighted ? 1.5 : 1} />

              {/* use-case node */}
              <rect x={LEFT} y={caseY} width={CASE_W} height={CASE_H} rx={10} fill="var(--color-inset)" stroke="var(--color-line-strong)" />
              <rect x={LEFT} y={caseY - 10} width={78} height={18} rx={4} fill="var(--color-raised)" stroke="var(--color-line)" />
              <text x={LEFT + 8} y={caseY + 3} fontSize={9.5} fontWeight={500} letterSpacing="0.6" fill="var(--color-muted)">USE CASE</text>
              <text x={LEFT + 14} y={caseY + 32} fontSize={13.5} fontWeight={500} fill="var(--color-fg)">{truncate(lane.useCase, 26)}</text>
              <text x={LEFT + 14} y={caseY + 54} fontSize={11} fill="var(--color-muted)">{lane.rows.length} {lane.rows.length === 1 ? "test" : "tests"}{lane.gaps.length ? ` · ${lane.gaps.length} ${lane.gaps.length === 1 ? "gap" : "gaps"}` : ""}</text>

              {/* trunk from the use case to every item */}
              {items.length > 0 && (
                <path
                  d={`M ${LEFT + CASE_W} ${centerY} H ${TRUNK_X} M ${TRUNK_X} ${Math.min(centerY, firstY + NODE_H / 2)} V ${Math.max(centerY, firstY + (items.length - 1) * ROW_H + NODE_H / 2)}`}
                  fill="none" stroke="var(--color-line-strong)" strokeWidth={1.5}
                />
              )}

              {items.map((item, i) => {
                const ny = firstY + i * ROW_H;
                const mid = ny + NODE_H / 2;
                if (item.kind === "test") {
                  const { row } = item;
                  const stroke = STATUS_STROKE[row.status];
                  return (
                    <g key={row.id} onClick={() => onSelect(row.id)} className="cursor-pointer" role="button" aria-label={`${row.flow.title}, ${row.status}`}>
                      <path d={`M ${TRUNK_X} ${mid} H ${NODE_X}`} fill="none" stroke="var(--color-line-strong)" strokeWidth={1.5} />
                      <rect x={NODE_X} y={ny} width={NODE_W} height={NODE_H} rx={8} fill="var(--color-surface)" stroke={stroke} strokeOpacity={row.status === "planned" ? 0.5 : 0.85} strokeWidth={1} />
                      <circle cx={NODE_X + 20} cy={mid} r={9} fill={stroke} fillOpacity={row.status === "planned" ? 0.25 : 0.15} />
                      <text x={NODE_X + 20} y={mid + 4} fontSize={11} textAnchor="middle" fill={stroke}>{STATUS_GLYPH[row.status]}</text>
                      <text x={NODE_X + 38} y={mid - 3} fontSize={12} fontWeight={500} fill="var(--color-fg)">{truncate(row.flow.title, 40)}</text>
                      <text x={NODE_X + 38} y={mid + 12} fontSize={10} fill="var(--color-muted)" fontFamily="var(--font-mono)">{row.id} · {row.flow.priority}</text>
                    </g>
                  );
                }
                return (
                  <g key={`gap-${i}`}>
                    <title>{item.gap.suggest}</title>
                    <path d={`M ${TRUNK_X} ${mid} H ${NODE_X}`} fill="none" stroke="var(--color-flaky)" strokeWidth={1.5} strokeDasharray="4 3" />
                    <rect x={NODE_X} y={ny} width={NODE_W} height={NODE_H} rx={8} fill="var(--color-flaky)" fillOpacity={0.07} stroke="var(--color-flaky)" strokeOpacity={0.5} strokeDasharray="5 4" />
                    <text x={NODE_X + 14} y={mid - 3} fontSize={12} fontWeight={500} fill="var(--color-flaky)">GAP · {truncate(item.gap.text, 36)}</text>
                    <text x={NODE_X + 14} y={mid + 12} fontSize={10} fill="var(--color-muted)">{truncate(item.gap.suggest, 52)}</text>
                  </g>
                );
              })}

              {/* lane badges */}
              <g transform={`translate(${WIDTH / 2 - 90}, ${top + h - 26})`}>
                <rect x={0} y={0} width={80} height={20} rx={6} fill="var(--color-inset)" stroke="var(--color-line)" />
                <text x={40} y={14} fontSize={10.5} textAnchor="middle" fill="var(--color-muted)">{lane.rows.length} tests</text>
                <rect x={90} y={0} width={90} height={20} rx={6} fill={lane.gaps.length ? "var(--color-flaky)" : "var(--color-inset)"} fillOpacity={lane.gaps.length ? 0.12 : 1} stroke={lane.gaps.length ? "var(--color-flaky)" : "var(--color-line)"} strokeOpacity={lane.gaps.length ? 0.4 : 1} />
                <text x={135} y={14} fontSize={10.5} textAnchor="middle" fill={lane.gaps.length ? "var(--color-flaky)" : "var(--color-muted)"}>{lane.gaps.length} gaps{lane.risk ? ` · ${lane.risk} risk` : ""}</text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
