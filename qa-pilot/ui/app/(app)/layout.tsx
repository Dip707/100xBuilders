"use client";
import { AuthProvider, useUser } from "@/lib/auth";
import { Sidebar } from "@/components/shell/Sidebar";
import { Spinner } from "@/components/ui";

/**
 * The real auth gate. middleware.ts only checks that a cookie exists, so a stale or
 * forged cookie reaches here; AuthProvider resolves it against the API and redirects on
 * a 401. Nothing inside the shell renders until that has settled, so a signed-out visitor
 * never sees run data flash on screen.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app">
        <Spinner size={22} />
      </div>
    );
  }
  if (!user) return null;
  return (
    <div className="flex min-h-screen bg-app">
      <Sidebar />
      <div className="min-w-0 flex-1 bg-surface">{children}</div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}
