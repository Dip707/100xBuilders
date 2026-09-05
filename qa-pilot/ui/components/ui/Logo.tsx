/*
 * The qa-pilot mark: a hub with three satellites hanging off it.
 *
 * It is the product's architecture drawn at logo scale - a meta-agent coordinating a
 * planner, a generator and a healer - which is the part of qa-pilot worth putting on the
 * tin: not that it runs tests, but that it decides what to test, writes it, and repairs
 * it without anyone in the loop. The hub is heavier than the three nodes because the
 * orchestration is the product; the sub-agents are what it directs.
 *
 * Geometry is on the same 24x24 grid as the Icon set, laid out from one construction:
 * satellites at 0, 120 and 240 degrees on a circle of radius 9.4 about the hub, the whole
 * arrangement pushed down 2.35 so the drawn bounds - not the hub - sit centred in the box.
 * Node radii and link weight are tuned for the 16px case, where anything tighter merges
 * into a single blob; see the notes in `app/icon.svg`.
 */

const HUB = { cx: 12, cy: 14.35, r: 3.35 };
const NODES = [
  { cx: 12, cy: 4.95 },
  { cx: 20.14, cy: 19.05 },
  { cx: 3.86, cy: 19.05 },
] as const;
const NODE_R = 2.1;
const LINK_WIDTH = 1.6;

/**
 * The mark alone, in `currentColor`, sized like an Icon.
 *
 * The links run hub-centre to node-centre and are drawn first, so both ends disappear
 * under the filled circles rather than needing to be trimmed to the two radii.
 */
export function Logo({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path
        d={NODES.map((n) => `M${HUB.cx} ${HUB.cy} ${n.cx} ${n.cy}`).join("")}
        fill="none"
        stroke="currentColor"
        strokeWidth={LINK_WIDTH}
        strokeLinecap="round"
      />
      <circle cx={HUB.cx} cy={HUB.cy} r={HUB.r} fill="currentColor" />
      {NODES.map((n) => (
        <circle key={`${n.cx},${n.cy}`} cx={n.cx} cy={n.cy} r={NODE_R} fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The mark in its tile - the form it takes everywhere in the chrome. `tone` picks which
 * pair of colours: "accent" flips with the theme the way every other action surface does,
 * "invert" is the fixed white-on-image version the sign-in art needs.
 */
export function LogoTile({ size = 28, tone = "accent" }: { size?: number; tone?: "accent" | "invert" }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-input ${
        tone === "accent" ? "bg-accent text-accent-fg" : "bg-white text-black"
      }`}
      style={{ width: size, height: size }}
    >
      <Logo size={Math.round(size * 0.72)} />
    </span>
  );
}

/** Tile plus wordmark. The lockup used in the sidebar header and on the sign-in art. */
export function LogoLockup({ tone = "accent", className = "" }: { tone?: "accent" | "invert"; className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoTile size={28} tone={tone} />
      <span className={`text-sm font-semibold tracking-[0.2px] ${tone === "accent" ? "text-fg" : "text-white"}`}>
        AEGIS
      </span>
    </span>
  );
}
