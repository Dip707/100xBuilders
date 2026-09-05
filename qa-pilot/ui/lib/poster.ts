/**
 * Picking a thumbnail frame for a finished test's recording.
 *
 * Playwright starts recording before the target app paints, so a recording opens on the
 * browser's blank page - which is what the player showed as its thumbnail. How long that
 * lead-in lasts depends on how quickly the app under test renders, so no fixed timestamp
 * and no fixed fraction of the duration finds a real frame reliably: measured across one
 * run's recordings it ranged from 0s to 1.2s, or 0% to 40% of the clip.
 *
 * So the frame is chosen by looking at it rather than by guessing: step through the early
 * part of the recording and stop at the first frame that is not a flat expanse of one
 * colour. The helpers here are the parts of that walk that do not need a browser.
 */

/** Fraction of pixels that must differ from the frame's corner before it counts as content. */
const CONTENT_PIXEL_RATIO = 0.02;

/** How far apart two 0-255 channel values must be to count as different. */
const CHANNEL_TOLERANCE = 12;

/**
 * Whether a frame looks like it has something on it.
 *
 * A pre-paint frame is a single flat colour - white in Chromium, but a dark-themed app or
 * a themed splash screen can be flat in any colour, so this measures flatness rather than
 * comparing against white specifically. The yardstick is the frame's mean colour, not a
 * corner pixel: pages routinely paint a header or nav into the top-left corner, and a
 * corner-pixel baseline would read those as the background and call the frame blank.
 *
 * `data` is RGBA, four bytes per pixel, as `CanvasRenderingContext2D.getImageData` returns.
 */
export function hasContent(data: Uint8ClampedArray | number[]): boolean {
  const pixels = Math.floor(data.length / 4);
  if (pixels === 0) return false;
  let [sr, sg, sb] = [0, 0, 0];
  for (let i = 0; i < pixels * 4; i += 4) {
    sr += data[i];
    sg += data[i + 1];
    sb += data[i + 2];
  }
  const [mr, mg, mb] = [sr / pixels, sg / pixels, sb / pixels];
  let differing = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    if (
      Math.abs(data[i] - mr) > CHANNEL_TOLERANCE ||
      Math.abs(data[i + 1] - mg) > CHANNEL_TOLERANCE ||
      Math.abs(data[i + 2] - mb) > CHANNEL_TOLERANCE
    ) {
      differing++;
    }
  }
  return differing / pixels > CONTENT_PIXEL_RATIO;
}

/** How many frames to sample, and how far into the recording to give up looking. */
const MAX_PROBES = 12;
const SEARCH_FRACTION = 0.6;

/**
 * Timestamps to try, in order, when hunting for the first frame with something on it.
 *
 * The walk starts at zero - a recording of an app that painted immediately should keep its
 * real first frame - and covers the opening stretch where the lead-in ends. It stops well
 * short of the end so a thumbnail still shows the test beginning rather than its outcome.
 */
export function probeTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const limit = duration * SEARCH_FRACTION;
  // Indexed rather than accumulated: adding a fractional step in a loop drifts, and the
  // drift is what decides whether the last probe falls inside the limit or just outside it.
  return Array.from({ length: MAX_PROBES }, (_, i) => Number(((limit / MAX_PROBES) * i).toFixed(3)));
}
