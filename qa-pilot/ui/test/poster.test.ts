import { describe, it, expect } from "vitest";
import { hasContent, probeTimes } from "@/lib/poster";

/** Builds an RGBA buffer of `pixels` pixels, the first `painted` of which are `colour`. */
const frame = (pixels: number, base: [number, number, number], painted = 0, colour: [number, number, number] = [0, 0, 0]) => {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = i < painted ? colour : base;
    data.set([r, g, b, 255], i * 4);
  }
  return data;
};

describe("hasContent", () => {
  it("rejects the blank white page a recording opens on", () => {
    expect(hasContent(frame(1000, [255, 255, 255]))).toBe(false);
  });

  it("rejects a flat frame of any colour, not just white", () => {
    // A dark-themed app's pre-paint frame, and a themed splash, are flat but not white.
    expect(hasContent(frame(1000, [17, 17, 19]))).toBe(false);
    expect(hasContent(frame(1000, [12, 74, 160]))).toBe(false);
  });

  it("tolerates the compression noise a flat frame picks up in a WebM", () => {
    const noisy = frame(1000, [255, 255, 255]);
    for (let i = 0; i < 1000; i++) {
      const jitter = 255 - (i % 9); // within the per-channel tolerance
      noisy.set([jitter, jitter, jitter, 255], i * 4);
    }
    expect(hasContent(noisy)).toBe(false);
  });

  it("accepts a frame once a real page has painted onto it", () => {
    // A login form covers far more than the threshold of a 1280x800 viewport.
    expect(hasContent(frame(1000, [255, 255, 255], 200))).toBe(true);
  });

  it("ignores a speck too small to be a painted page", () => {
    // One stray cursor or favicon pixel is not the app having rendered.
    expect(hasContent(frame(1000, [255, 255, 255], 5))).toBe(false);
  });

  it("accepts a page that paints into the top-left corner", () => {
    // Judging the frame against its corner pixel reads a full-bleed header as the
    // background and calls the frame blank, which is how most apps' first frame looks.
    expect(hasContent(frame(1000, [255, 255, 255], 300, [20, 20, 24]))).toBe(true);
  });

  it("treats an empty buffer as blank rather than throwing", () => {
    expect(hasContent(new Uint8ClampedArray(0))).toBe(false);
  });
});

describe("probeTimes", () => {
  it("starts at zero, so a recording that painted immediately keeps its first frame", () => {
    expect(probeTimes(2.28)[0]).toBe(0);
  });

  it("stops short of the end, so a thumbnail shows the test starting, not its outcome", () => {
    const times = probeTimes(10);
    expect(Math.max(...times)).toBeLessThan(10 * 0.6);
  });

  it("covers the lead-in observed in real recordings", () => {
    // auth-002 was blank until 0.90s of 2.28s; the walk has to reach past that.
    const times = probeTimes(2.28);
    expect(times.some((t) => t >= 0.9)).toBe(true);
  });

  it("bounds the number of seeks regardless of how long the recording is", () => {
    for (const duration of [0.5, 2.28, 30, 600]) expect(probeTimes(duration).length).toBeLessThanOrEqual(12);
  });

  it("gives up on a duration the media element could not work out", () => {
    // A WebM with no duration in its header reports Infinity until it has fully played.
    expect(probeTimes(Infinity)).toEqual([]);
    expect(probeTimes(NaN)).toEqual([]);
    expect(probeTimes(0)).toEqual([]);
  });
});
