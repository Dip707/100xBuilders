import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

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
