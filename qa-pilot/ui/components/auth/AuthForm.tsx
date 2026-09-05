"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Icon, Input, LogoLockup, Spinner, ThemeToggle, wallpaperVars } from "@/components/ui";
import { login, signup } from "@/lib/api";

const COPY = {
  login: { title: "Sign in", cta: "Sign in", altText: "Need an account?", altLabel: "Create one", altHref: "/signup" },
  signup: { title: "Create an account", cta: "Create account", altText: "Already have an account?", altLabel: "Sign in", altHref: "/login" },
} as const;

const PITCH = [
  { icon: "target" as const, text: "Explores the app and writes a plan that covers the flows a person would actually break." },
  { icon: "flask" as const, text: "Generates Playwright tests, validating every selector against the live app as it goes." },
  { icon: "wand" as const, text: "Repairs what breaks, and tells a broken test apart from a genuine defect." },
];

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
    <main className="grid min-h-screen grid-rows-[auto_1fr] bg-app lg:grid-cols-[1.1fr_1fr] lg:grid-rows-1">
      {/*
        The one full-bleed image in the app. Everywhere else the canvas stays flat; the
        sign-in screen has nothing else on it, and a bare form centred on near-black reads
        as an error page rather than a product.
      */}
      <aside className="relative flex min-h-[13rem] flex-col justify-between overflow-hidden border-b border-line lg:min-h-0 lg:border-b-0 lg:border-r">
        <div aria-hidden="true" style={wallpaperVars("aurora")} className="wallpaper-plate absolute inset-0" />
        {/*
          Just enough scrim to hold the copy, not enough to bury the art. The previous
          gradient started at 85% black and the wallpaper read as a flat dark panel.
        */}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-tr from-black/70 via-black/35 to-transparent" />

        <div className="relative p-6 lg:p-8">
          <LogoLockup tone="invert" />
        </div>

        <div className="relative max-w-md p-8 pb-12 max-lg:hidden">
          <h2 className="text-[32px] font-medium leading-[1.15] tracking-[0.2px] text-white">
            Autonomous test orchestration.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">
            Give it a URL. It does the rest, and shows its work at every stage.
          </p>
          <ul className="mt-8 space-y-3.5">
            {PITCH.map((p) => (
              <li key={p.text} className="flex gap-3 text-[13.5px] leading-relaxed text-white/80">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-chip border border-white/15 bg-white/10 text-white">
                  <Icon name={p.icon} size={13} />
                </span>
                {p.text}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="relative flex items-center justify-center bg-surface px-6 py-12">
        <div className="absolute right-4 top-4"><ThemeToggle /></div>

        <div className="w-full max-w-[360px]">
          <div className="mb-8 space-y-1.5">
            <h1 className="text-[24px] font-medium tracking-[0.2px] text-fg">{copy.title}</h1>
            <p className="text-[13.5px] text-muted">
              {mode === "login" ? "Welcome back." : "Runs are scoped to your account."} AEGIS autonomous test orchestration.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-[13px] font-medium tracking-[0.2px] text-fg">Email</label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-[13px] font-medium tracking-[0.2px] text-fg">Password</label>
              <Input
                id="password" type="password" required minLength={8} value={password}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters"
              />
            </div>

            {error && (
              <p role="alert" className="flex items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
                <Icon name="alert" size={14} /> {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <><Spinner /> working</> : copy.cta}
            </Button>
          </form>

          <p className="mt-6 text-center text-[13px] text-muted">
            {copy.altText}{" "}
            <Link href={copy.altHref} className="font-medium text-fg underline-offset-4 hover:underline">{copy.altLabel}</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
