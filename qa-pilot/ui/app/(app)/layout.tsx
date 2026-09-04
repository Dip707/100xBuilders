"use client";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider, useUser } from "@/lib/auth";
import { RunProvider } from "@/lib/run-context";
import { runIdFromPath } from "@/lib/stages";
import { Sidebar } from "@/components/shell/Sidebar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { Spinner } from "@/components/ui";

/**
 * The real auth gate. middleware.ts only checks that a cookie exists, so a stale or
 * forged cookie reaches here; AuthProvider resolves it against the API and redirects on
 * a 401. Nothing inside the shell renders until that has settled, so a signed-out visitor
 * never sees run data flash on screen.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  const runId = runIdFromPath(usePathname());
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app">
        <Spinner size={20} />
      </div>
    );
  }
  if (!user) return null;
  return (
    // The run subscription wraps the rail as well as the content, so the rail can badge
    // each stage live from the same events the screens render.
    <RunProvider runId={runId}>
      <div className="flex min-h-screen bg-app">
        <Sidebar />
        {/*
          The content column sits one notch above the canvas the rail is painted on, which
          is the whole of the separation between them - that plus a single hairline.
        */}
        <div className="relative isolate min-w-0 flex-1 bg-surface">{children}</div>
        <CommandPalette />
      </div>
    </RunProvider>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {/* RunProvider reads the `test` search parameter, which needs a Suspense boundary. */}
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-app"><Spinner size={20} /></div>}>
        <Gate>{children}</Gate>
      </Suspense>
    </AuthProvider>
  );
}
