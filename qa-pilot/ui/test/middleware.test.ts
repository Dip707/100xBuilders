import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";

const SESSION_COOKIE = "qa_pilot_session";

function makeRequest(path: string, opts: { withCookie?: boolean } = {}): NextRequest {
  const headers = new Headers();
  if (opts.withCookie) headers.set("cookie", `${SESSION_COOKIE}=stale-or-valid-value`);
  return new NextRequest(new Request(`http://localhost:3000${path}`, { headers }));
}

function isRedirectTo(res: Response, pathname: string): boolean {
  if (res.status !== 307) return false;
  const location = res.headers.get("location");
  if (!location) return false;
  return new URL(location).pathname === pathname;
}

describe("middleware", () => {
  it("no cookie, protected path (/) redirects to /login", () => {
    const res = middleware(makeRequest("/"));
    expect(isRedirectTo(res, "/login")).toBe(true);
  });

  it("no cookie, /login passes through (not a redirect)", () => {
    const res = middleware(makeRequest("/login"));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("cookie present, /login passes through (regression: this used to bounce to / and loop forever)", () => {
    const res = middleware(makeRequest("/login", { withCookie: true }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("cookie present, / passes through (not a redirect)", () => {
    const res = middleware(makeRequest("/", { withCookie: true }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });
});

/**
 * The matcher decides which requests reach the function at all, so it is the only place a
 * static asset can be excluded. It is tested separately because middleware() itself never
 * sees the matcher - Next applies it upstream.
 */
describe("middleware matcher", () => {
  const pattern = new RegExp(`^${config.matcher[0]}$`);

  it.each([
    "/",
    "/runs/new",
    "/runs/abc123/cases",
    "/login",
  ])("runs on the app route %s", (path) => {
    expect(pattern.test(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    // Served as routes rather than from /public, so they only escape the redirect by
    // being named here - and the sign-in screen is exactly where a signed-out browser
    // asks for them.
    "/icon.svg",
    "/apple-icon.png",
    // The login page's own background lives here, so gating it behind the login redirect
    // means the sign-in screen can never render its wallpaper.
    "/wallpapers/chromatic_dark_1.png",
    "/wallpapers/mono_dark_distortion_1.png",
  ])("skips the static asset %s", (path) => {
    expect(pattern.test(path)).toBe(false);
  });
});
