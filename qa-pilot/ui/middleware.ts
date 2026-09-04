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
  // Deliberately no "hasCookie && isPublic -> redirect to /" rule here. Middleware can
  // only see that a cookie exists, not whether it is still valid: a visitor whose session
  // expired keeps the cookie until the API clears it. That old rule bounced such a
  // visitor straight back to / from /login, and AuthProvider's own redirect to /login (on
  // a 401 from /auth/me) went right back through this middleware and got bounced again -
  // an infinite loop that made the login form unreachable. Omitting the rule trades a
  // cosmetic issue (an already-signed-in visitor can still see the login form) for a
  // functional one (being unable to log in at all), which is the right side to take.
  return NextResponse.next();
}

/*
 * `wallpapers` is excluded alongside Next's own static paths because the sign-in screen's
 * background lives there: anything under /public that a signed-out page renders has to be
 * reachable without a session, or the redirect fires on the asset and the login screen
 * loads without the one image it needs.
 *
 * The app icons need the same exemption for the same reason, and they are easy to miss:
 * `app/icon.svg` and `app/apple-icon.png` are served by Next as routes, not as files under
 * /public, so without them listed here the browser asks for the tab icon on the sign-in
 * screen and gets a 307 to /login.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|wallpapers/).*)"],
};
