import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "qa_pilot_session";
const PUBLIC = ["/login", "/signup"];

/**
 * A convenience, not a security boundary. It only checks that the cookie exists, so a
 * forged value gets past it and is then rejected by the API with a 401, which
 * AuthProvider turns into a redirect.
 *
 * This works because cookies are not scoped by port: the API on :4000 sets the cookie
 * for host "localhost", so requests to the Next server on :3000 carry it. If the API and
 * the UI are ever served from different hostnames this stops firing, and the auth gate in
 * app/(app)/layout.tsx is what handles it. That gate must therefore stand on its own.
 */
export function middleware(req: NextRequest) {
  const hasCookie = req.cookies.has(SESSION_COOKIE);
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!hasCookie && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (hasCookie && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
