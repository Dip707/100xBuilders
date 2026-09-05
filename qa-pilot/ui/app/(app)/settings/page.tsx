"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { IntegrationsCard } from "@/components/settings/IntegrationsCard";
import { connectIntegration, disconnectIntegration, getIntegration, type ConnectInput, type IntegrationPublic } from "@/lib/api";

/** Only a path on this site may be returned to, never another origin. */
function safeReturn(raw: string | null): string | null {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}

export default function SettingsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturn(params.get("return"));
  const [integration, setIntegration] = useState<IntegrationPublic | null | undefined>(undefined);

  useEffect(() => {
    getIntegration().then(setIntegration).catch(() => setIntegration(null));
  }, []);

  async function connect(input: ConnectInput) {
    const next = await connectIntegration(input);
    setIntegration(next);
    // Sent here from a chat: go back to it, where the row that needed this now reads "Raise in".
    if (returnTo) router.push(returnTo);
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
        <IntegrationsCard integration={integration} onConnect={connect} onDisconnect={disconnect} />
      </div>
    </div>
  );
}
