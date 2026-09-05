import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Viewport } from "@/components/sources/Viewport";
import type { Frame } from "@/lib/frames";

/*
 * The Sources viewport has two faces - the explorer's live browser while it crawls, the
 * recording of that crawl afterwards - and which one you get is the whole point of the
 * screen. The live face is only on screen for the length of a crawl, which on a small
 * local target is under fifteen seconds, so it is not something you can reliably catch by
 * hand. Rendering the component to static markup pins both faces instead.
 */

const frames: Frame[] = [
  { index: 1, rel: "traces/explore/a.png", label: "goto /", at: "2026-09-05T12:00:00.000Z", offsetMs: 0 },
  { index: 2, rel: "traces/explore/b.png", label: "click Sign In", at: "2026-09-05T12:00:07.000Z", offsetMs: 7000 },
];

const render = (props: Partial<Parameters<typeof Viewport>[0]> = {}) =>
  renderToStaticMarkup(
    <Viewport
      runId="run-1" liveSrc={null} frames={frames} current={1}
      onSeek={() => {}} playing={false} onPlayingChange={() => {}}
      {...props}
    />,
  );

describe("Viewport, while the crawl is live", () => {
  const live = "data:image/jpeg;base64,AAAA";

  it("shows the streamed frame rather than a saved screenshot", () => {
    const html = render({ liveSrc: live });
    expect(html).toContain(`src="${live}"`);
    expect(html).toContain("Live view of the explorer&#x27;s browser");
    expect(html).not.toContain("traces/explore/");
  });

  it("marks the picture as live", () => {
    expect(render({ liveSrc: live })).toContain("Live");
  });

  // There is nothing to scrub through while the recording is still being made.
  it("offers no transport", () => {
    const html = render({ liveSrc: live });
    expect(html).not.toContain('aria-label="Recording position"');
    expect(html).not.toContain('aria-label="Play the recording"');
  });
});

describe("Viewport, once the crawl has finished", () => {
  it("shows the current saved frame and its caption", () => {
    const html = render({ current: 2 });
    expect(html).toContain("traces/explore/b.png");
    expect(html).toContain("click Sign In · 0:07");
  });

  it("offers the transport, positioned on the current frame", () => {
    const html = render({ current: 2 });
    expect(html).toContain('aria-label="Recording position"');
    expect(html).toContain('max="2"');
    expect(html).toContain("2/2");
  });

  it("drops the live marker", () => {
    expect(render()).not.toContain("Live view of");
  });

  it("says it is waiting when no frame has been captured yet", () => {
    const html = render({ frames: [] });
    expect(html).toContain("waiting for the first frame");
    expect(html).not.toContain('aria-label="Recording position"');
  });

  it("labels the button pause while playing and replay at the end", () => {
    expect(render({ playing: true, current: 1 })).toContain('aria-label="Pause the recording"');
    expect(render({ current: 2 })).toContain('aria-label="Play the recording"');
  });
});
