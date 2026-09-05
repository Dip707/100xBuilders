"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card, Icon, Spinner, TrackerLogo } from "@/components/ui";
import type { IntegrationPublic, TrackerDestination, TrackerProvider } from "@/lib/api";
import { relativeTime } from "@/lib/format";

const PROVIDER_NAME: Record<TrackerProvider, string> = { linear: "Linear", jira: "Jira" };

/**
 * One tracker per account, connected through Composio's OAuth. Clicking Connect leaves this
 * page for the tracker's own consent screen and comes back to Settings; nothing typed here is
 * ever a credential. Once the tracker has answered, the only thing left to choose is where
 * issues go: a Linear team or a Jira project.
 */
export function IntegrationsCard({
  integration, error, returnTo, onConnect, loadDestinations, onPickDestination, onDisconnect,
}: {
  /** undefined while loading, null when nothing is connected. */
  integration: IntegrationPublic | null | undefined;
  /** A failure reported by the OAuth callback, shown in the card's error line. */
  error?: string | null;
  /** Where the person came from, so a finished connection can send them back. */
  returnTo?: string | null;
  onConnect: (provider: TrackerProvider) => Promise<void>;
  loadDestinations: () => Promise<TrackerDestination[]>;
  onPickDestination: (id: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<TrackerDestination[] | null>(null);
  const [choice, setChoice] = useState("");
  const shownError = localError ?? error ?? null;

  const needsDestination = integration?.status === "active" && !integration.destination;
  useEffect(() => {
    if (!needsDestination) return;
    let cancelled = false;
    loadDestinations()
      .then((list) => { if (!cancelled) { setDestinations(list); setChoice(list[0]?.id ?? ""); } })
      .catch((err) => { if (!cancelled) setLocalError((err as Error).message); });
    return () => { cancelled = true; };
  }, [needsDestination, loadDestinations]);

  async function act(key: string, fn: () => Promise<void>) {
    setLocalError(null);
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (integration === undefined) {
    return (
      <Card title="Integrations">
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted"><Spinner size={12} /> Loading</div>
      </Card>
    );
  }

  const errorLine = shownError && <p role="alert" className="pb-4 text-[13px] text-fail">{shownError}</p>;

  if (integration?.status === "active" && integration.destination) {
    return (
      <Card title="Integrations" actions={<Button variant="outline" size="sm" onClick={() => void act("disconnect", onDisconnect)} disabled={busy !== null}>Disconnect</Button>}>
        <div className="flex items-center gap-3 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-inset"><TrackerLogo name={integration.provider} size={16} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">{integration.label}</p>
            <p className="text-[12px] text-muted">Connected {relativeTime(integration.connectedAt)}. Defects the copilot files go to {integration.destination.label} in {PROVIDER_NAME[integration.provider]}.</p>
          </div>
          {returnTo && (
            <Link href={returnTo} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-input bg-accent px-3 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover">
              Back to the copilot <Icon name="arrowRight" size={12} />
            </Link>
          )}
        </div>
        {errorLine}
      </Card>
    );
  }

  if (integration?.status === "active") {
    return (
      <Card title="Integrations" actions={<Button variant="outline" size="sm" onClick={() => void act("disconnect", onDisconnect)} disabled={busy !== null}>Disconnect</Button>}>
        <p className="flex items-center gap-2 py-4 text-[13px] leading-relaxed text-muted">
          <TrackerLogo name={integration.provider} size={14} /> {PROVIDER_NAME[integration.provider]} is connected. Pick the {integration.provider === "linear" ? "team" : "project"} the copilot should file defects in.
        </p>
        <div className="flex items-center gap-3 pb-4">
          {destinations === null ? (
            <span className="inline-flex items-center gap-2 text-[13px] text-muted"><Spinner size={12} /> Loading {integration.provider === "linear" ? "teams" : "projects"}</span>
          ) : destinations.length === 0 ? (
            <span className="text-[13px] text-muted">This account has no {integration.provider === "linear" ? "teams" : "projects"} to file into.</span>
          ) : (
            <>
              <select
                aria-label={integration.provider === "linear" ? "Team" : "Project"} value={choice} onChange={(e) => setChoice(e.target.value)}
                className="h-9 min-w-[16rem] rounded-input border border-line bg-inset px-3 text-sm text-fg focus:border-line-strong focus:outline-none"
              >
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              <Button size="sm" onClick={() => void act("save", () => onPickDestination(choice))} disabled={busy !== null || !choice}>
                {busy === "save" ? <><Spinner size={11} /> Saving</> : "Save"}
              </Button>
            </>
          )}
        </div>
        {errorLine}
      </Card>
    );
  }

  return (
    <Card title="Integrations">
      <p className="py-4 text-[13px] leading-relaxed text-muted">
        Connect a tracker and the copilot can file a ticket for any failure the classifier called an app defect. Connecting opens the tracker&apos;s own sign-in and brings you back here; AEGIS never sees a password or an API key.
      </p>
      {integration?.status === "pending" && (
        <p className="pb-4 text-[13px] text-muted">The last attempt to connect {PROVIDER_NAME[integration.provider]} did not finish. Try again.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {(["linear", "jira"] as const).map((provider) => (
          <Button key={provider} size="sm" variant="outline" onClick={() => void act(provider, () => onConnect(provider))} disabled={busy !== null}>
            {busy === provider ? <><Spinner size={11} /> Opening {PROVIDER_NAME[provider]}</> : <><TrackerLogo name={provider} size={14} /> Connect {PROVIDER_NAME[provider]}</>}
          </Button>
        ))}
      </div>
      {errorLine}
    </Card>
  );
}
