"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Spinner } from "@/components/ui";
import { login, signup } from "@/lib/api";

const COPY = {
  login: { title: "Sign in", cta: "Sign in", altText: "Need an account?", altLabel: "Create one", altHref: "/signup" },
  signup: { title: "Create an account", cta: "Create account", altText: "Already have an account?", altLabel: "Sign in", altHref: "/login" },
} as const;

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const copy = COPY[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === "login" ? login(email, password) : signup(email, password));
      // The API set the session cookie on this response, so a full navigation is what
      // lets middleware see it on the next request.
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-box bg-accent text-sm font-bold text-white">qp</div>
          <h1 className="text-2xl font-semibold text-fg">{copy.title}</h1>
          <p className="text-sm text-muted">qa-pilot autonomous test orchestration</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-card border border-line bg-surface p-6">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-fg">Email</label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-fg">Password</label>
            <Input
              id="password" type="password" required minLength={8} value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters"
            />
          </div>

          {error && <p role="alert" className="rounded-input bg-fail/10 px-3 py-2 text-sm text-fail">{error}</p>}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? <><Spinner /> working</> : copy.cta}
          </Button>
        </form>

        <p className="text-center text-sm text-muted">
          {copy.altText} <Link href={copy.altHref} className="font-medium text-accent hover:underline">{copy.altLabel}</Link>
        </p>
      </div>
    </main>
  );
}
