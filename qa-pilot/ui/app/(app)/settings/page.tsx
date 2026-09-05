"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { IntegrationsCard } from "@/components/settings/IntegrationsCard";
import { disconnectIntegration, getIntegration, listDestinations, setDestination, startConnect, type IntegrationPublic, type TrackerProvider } from "@/lib/api";

/** Only a path on this site may be returned to, never another origin. */
function safeReturn(raw: string | null): string | null {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}

export default function SettingsPage() {
  const params = useSearchParams();
  const returnTo = safeReturn(params.get("return"));
  const callbackError = params.get("error");
  const [integration, setIntegration] = useState<IntegrationPublic | null | undefined>(undefined);

  useEffect(() => {
    getIntegration().then(setIntegration).catch(() => setIntegration(null));
  }, []);

  // The OAuth consent screen lives on the tracker's site, so the whole tab goes there and
  // Composio brings it back to the API's callback, which lands on this page again.
  async function connect(provider: TrackerProvider) {
    const redirectUrl = await startConnect(provider, returnTo);
    window.location.assign(redirectUrl);
  }

  const loadDestinations = useCallback(() => listDestinations(), []);

  async function pickDestination(id: string) {
    setIntegration(await setDestination(id));
  }

  async function disconnect() {
    await disconnectIntegration();
    setIntegration(null);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        crumbs={[{ label: "Runs", href: "/" }, { label: "Settings" }]}
        title="Settings"
        subtitle="Where defects go once the classifier has called them. One tracker per account."
      />
      <div className="mx-auto w-full max-w-[760px] px-6 py-6">
        <IntegrationsCard
          integration={integration} error={callbackError} returnTo={returnTo}
          onConnect={connect} loadDestinations={loadDestinations} onPickDestination={pickDestination} onDisconnect={disconnect}
        />
      </div>
    </div>
  );
}
