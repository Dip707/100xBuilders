/*
 * Raycast's own wallpapers, used as ambient plates behind the page headers.
 *
 * Every plate is a matched pair: the dark art on the dark canvas, the light art on the
 * light one. A single dark image dimmed under a light theme goes grey and muddy, so the
 * pair is what lets the imagery survive the theme toggle. `.wallpaper-plate` in
 * globals.css picks whichever of the two custom properties matches the active theme.
 */
const WALLPAPERS = {
  aurora: { dark: "chromatic_dark_1", light: "chromatic_light_1" },
  prism: { dark: "chromatic_dark_2", light: "chromatic_light_2" },
  ridge: { dark: "mono_dark_distortion_1", light: "mono_light_distortion_1" },
  drift: { dark: "mono_dark_distortion_2", light: "mono_light_distortion_2" },
  loupe: { dark: "loupe-mono-dark", light: "loupe-mono-light" },
} as const;

export type WallpaperName = keyof typeof WALLPAPERS;

/** The two plate URLs as custom properties, for anything that wants its own geometry. */
export function wallpaperVars(name: WallpaperName): React.CSSProperties {
  const { dark, light } = WALLPAPERS[name];
  return {
    "--wallpaper-dark": `url('/wallpapers/${dark}.jpg')`,
    "--wallpaper-light": `url('/wallpapers/${light}.jpg')`,
  } as React.CSSProperties;
}

/**
 * A masked wash across the top of a screen, sitting behind the sticky header so the
 * header's backdrop-blur has something to blur. Purely decorative: it is
 * `aria-hidden`, ignores pointer events, and sits on a negative layer so nothing has to
 * be re-stacked around it. The nearest positioned ancestor must be `relative isolate`.
 */
export function Wallpaper({ name, className = "" }: { name: WallpaperName; className?: string }) {
  return (
    <div
      aria-hidden="true"
      style={wallpaperVars(name)}
      className={`wallpaper-plate pointer-events-none absolute inset-x-0 top-0 -z-10 h-[380px] opacity-75 [mask-image:linear-gradient(to_bottom,#000_0%,rgba(0,0,0,0.7)_50%,transparent_100%)] ${className}`}
    />
  );
}
