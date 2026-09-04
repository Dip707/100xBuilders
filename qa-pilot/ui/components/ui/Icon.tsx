/*
 * The app's whole icon vocabulary, as 24x24 stroked paths rendered at whatever size the
 * caller asks for. Everything here used to be a unicode glyph (⌂ ＋ ⌘ ☰ ▷ ⌕ ◌ ✕), which
 * is the single detail that made the old chrome read as unfinished: glyph metrics differ
 * per font, they never align on a baseline with their label, and half of them fall back
 * to a system emoji face.
 *
 * Every icon inherits `currentColor` and a 1.5 stroke, so an icon in a status pill is the
 * colour of the pill's text without the caller doing anything.
 */

const PATHS = {
  // navigation
  home: "M3 10.5 12 3l9 7.5M5.5 9v11h13V9",
  plus: "M12 5v14M5 12h14",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 11.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  pause: "M9 5.5v13M15 5.5v13",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H20v18H6.5A1.5 1.5 0 0 1 5 19.5v-15ZM5 17.5A1.5 1.5 0 0 1 6.5 16H20M9.5 7.5h6.5",
  gauge: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18ZM12 12l4-4",

  // chevrons and arrows
  chevronLeft: "m14.5 6-6 6 6 6",
  chevronRight: "m9.5 6 6 6-6 6",
  chevronDown: "m6 9.5 6 6 6-6",
  chevronUpDown: "m8 10 4-4 4 4M8 14l4 4 4-4",
  arrowRight: "M4 12h15m-6-6 6 6-6 6",
  externalLink: "M14 4h6v6M20 4l-9 9M18 14v5.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5H10",
  download: "M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v3h16v-3",
  arrowUp: "M12 20V5m0 0-6 6m6-6 6 6",

  // status
  check: "m5 12.5 4.5 4.5L19 7",
  x: "m6 6 12 12M18 6 6 18",
  dashedCircle: "M12 3a9 9 0 0 1 4.5 1.2M19.8 7.5A9 9 0 0 1 21 12M19.8 16.5a9 9 0 0 1-3.3 3.3M12 21a9 9 0 0 1-4.5-1.2M4.2 16.5A9 9 0 0 1 3 12M4.2 7.5a9 9 0 0 1 3.3-3.3",
  halfCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18a9 9 0 0 0 0-18Z",
  minus: "M6 12h12",
  alert: "M12 4 2.8 20h18.4L12 4ZM12 10v4.5M12 17.5h.01",
  dot: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
  ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5.2l3.4 2",

  // pipeline / agents
  wand: "M4 20 15 9M13.5 4.5 15 3l1.5 1.5L15 6l-1.5-1.5ZM19 8l1.5-1.5M9 4l.8.8M20 13.5l.8.8",
  pen: "M4 20h4L19.2 8.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z",
  bolt: "M13.5 3 5 13.5h6L10.5 21 19 10.5h-6L13.5 3Z",
  hand: "M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0V15",
  clipboard: "M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15M9 4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5 1.5 1.5 0 0 1 13.5 6h-3A1.5 1.5 0 0 1 9 4.5ZM9.5 12h5M9.5 16h5",
  sparkles: "M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7 10.4 11.2 6 9.6 10.4 8 12 3.5ZM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z",
  bug: "M8 7.5a4 4 0 0 1 8 0M6.5 11h11v3.5a5.5 5.5 0 0 1-11 0V11ZM6.5 13H3.8M20.2 13h-2.7M7.4 17.6 5.4 19.4M16.6 17.6l2 1.8",

  // controls
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16 16l4.5 4.5",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z",
  refresh: "M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4",
  sun: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z",
  logOut: "M15 17l5-5-5-5M20 12H9M12 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H12",
  panelRight: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM14 4v16",
  code: "m9 8-5 4 5 4M15 8l5 4-5 4",
  image: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM4 16l4.5-4.5 4 4L15.5 13 20 17M15 8.5h.01",
  file: "M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9l-6-6ZM13 3v6h6",
  flask: "M9.5 3v6L4.6 17.6A2 2 0 0 0 6.3 20.6h11.4a2 2 0 0 0 1.7-3L14.5 9V3M8 3h8M7.2 14h9.6",
  filter: "M3.5 5h17l-6.5 7.5V20l-4-2.5v-5L3.5 5Z",

  // chat panel
  chat: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4V5.5Z",
  paperclip: "M17.5 9.5 10 17a3.5 3.5 0 0 1-5-5l7.8-7.8a2.5 2.5 0 0 1 3.6 3.6l-7.9 7.8a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10.5 11v6M13.5 11v6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
