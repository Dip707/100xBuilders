"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { me, logout as apiLogout, ApiError, type PublicUser } from "./api";

type AuthState = { user: PublicUser | null; loading: boolean; signOut: () => Promise<void> };

const Ctx = createContext<AuthState>({ user: null, loading: true, signOut: async () => {} });

/**
 * Resolves the session against the API rather than trusting the cookie. `middleware.ts`
 * only checks that a cookie is present, so this is the component that actually knows
 * whether the caller is signed in, and it is what has to redirect on a stale cookie.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    me()
      .then((u) => { if (!cancelled) setUser(u); })
      .catch(async (err) => {
        if (cancelled || !(err instanceof ApiError) || err.status !== 401) return;
        // The cookie is stale (expired/invalid session) but still present, and it is
        // httpOnly so only the API can clear it. Without this, middleware.ts keeps
        // seeing a cookie on every retry to /login, and (previously) bounced the
        // visitor straight back to /, an infinite loop that never reaches the login
        // form. Clear it via the API before redirecting so the next load has no cookie.
        await apiLogout().catch(() => {});
        if (!cancelled) router.replace("/login");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router]);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => {});
    setUser(null);
    router.replace("/login");
  }, [router]);

  return <Ctx.Provider value={{ user, loading, signOut }}>{children}</Ctx.Provider>;
}

export const useUser = () => useContext(Ctx);
