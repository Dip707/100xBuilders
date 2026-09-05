"use client";
import { useState } from "react";
import { Button, Card, CardRow, Field, Icon, Input, Segmented, Spinner } from "@/components/ui";
import type { ConnectInput, IntegrationPublic, TrackerProvider } from "@/lib/api";
import { relativeTime } from "@/lib/format";

const PROVIDER_NAME: Record<TrackerProvider, string> = { linear: "Linear", jira: "Jira" };

type Fields = { apiKey: string; teamKey: string; baseUrl: string; email: string; apiToken: string; projectKey: string };
const EMPTY: Fields = { apiKey: "", teamKey: "", baseUrl: "", email: "", apiToken: "", projectKey: "" };

function toInput(provider: TrackerProvider, f: Fields): ConnectInput {
  if (provider === "linear") return { provider, apiKey: f.apiKey.trim(), ...(f.teamKey.trim() ? { teamKey: f.teamKey.trim() } : {}) };
  return { provider, baseUrl: f.baseUrl.trim(), email: f.email.trim(), apiToken: f.apiToken, projectKey: f.projectKey.trim() };
}

function complete(provider: TrackerProvider, f: Fields): boolean {
  return provider === "linear" ? f.apiKey.trim().length > 0 : [f.baseUrl, f.email, f.apiToken, f.projectKey].every((v) => v.trim().length > 0);
}

/**
 * One tracker per account. Credentials go straight to the API, which verifies them against
 * the tracker and stores them sealed; the card only ever gets back the provider and a label,
 * so nothing here holds a key once the form is submitted.
 */
export function IntegrationsCard({
  integration, onConnect, onDisconnect, initialProvider = "linear",
}: {
  /** undefined while loading, null when nothing is connected. */
  integration: IntegrationPublic | null | undefined;
  onConnect: (input: ConnectInput) => Promise<void>;
  onDisconnect: () => Promise<void>;
  initialProvider?: TrackerProvider;
}) {
  const [provider, setProvider] = useState<TrackerProvider>(initialProvider);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onConnect(toInput(provider, fields));
      setFields(EMPTY);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      await onDisconnect();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (integration === undefined) {
    return (
      <Card title="Integrations">
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted"><Spinner size={12} /> Loading</div>
      </Card>
    );
  }

  if (integration) {
    return (
      <Card title="Integrations" actions={<Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy}>Disconnect</Button>}>
        <div className="flex items-center gap-3 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-inset text-body"><Icon name="bug" size={15} /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{integration.label}</p>
            <p className="text-[12px] text-muted">Connected {relativeTime(integration.connectedAt)}. Defects the copilot files go to {PROVIDER_NAME[integration.provider]}.</p>
          </div>
        </div>
        {error && <p role="alert" className="pb-4 text-[13px] text-fail">{error}</p>}
      </Card>
    );
  }

  return (
    <form onSubmit={(e) => void connect(e)}>
      <Card
        title="Integrations"
        actions={<Segmented options={[{ value: "linear", label: "Linear" }, { value: "jira", label: "Jira" }]} value={provider} onChange={(p) => { setProvider(p); setError(null); }} />}
      >
        <p className="py-4 text-[13px] leading-relaxed text-muted">
          Connect a tracker and the copilot can file a ticket for any failure the classifier called an app defect. The key is checked against {PROVIDER_NAME[provider]} now and stored encrypted; it is never shown again.
        </p>
        {provider === "linear" ? (
          <>
            <CardRow>
              <Field label="API key" required help="Linear › Settings › API › Personal API keys. Needs write access to issues.">
                <Input type="password" autoComplete="off" value={fields.apiKey} onChange={set("apiKey")} placeholder="lin_api_…" required />
              </Field>
            </CardRow>
            <CardRow>
              <Field label="Team key" help="The prefix of the team's issue ids, such as ENG. Optional when the account has one team.">
                <Input value={fields.teamKey} onChange={set("teamKey")} placeholder="ENG" />
              </Field>
            </CardRow>
          </>
        ) : (
          <>
            <CardRow>
              <Field label="Site URL" required>
                <Input type="url" value={fields.baseUrl} onChange={set("baseUrl")} placeholder="https://acme.atlassian.net" required />
              </Field>
            </CardRow>
            <CardRow>
              <Field label="Email" required help="The Atlassian account the API token belongs to.">
                <Input type="email" value={fields.email} onChange={set("email")} placeholder="you@acme.com" required />
              </Field>
            </CardRow>
            <CardRow>
              <Field label="API token" required help="id.atlassian.com › Security › API tokens.">
                <Input type="password" autoComplete="off" value={fields.apiToken} onChange={set("apiToken")} required />
              </Field>
            </CardRow>
            <CardRow>
              <Field label="Project key" required help="Issues are filed as Bug in this project, or its first issue type when it has no Bug.">
                <Input value={fields.projectKey} onChange={set("projectKey")} placeholder="ACME" required />
              </Field>
            </CardRow>
          </>
        )}
        <div className="flex items-center justify-between gap-4 py-4">
          <p role={error ? "alert" : undefined} className={`text-[13px] ${error ? "text-fail" : "text-subtle"}`}>
            {error ?? `Checked against ${PROVIDER_NAME[provider]} before it is saved.`}
          </p>
          <Button type="submit" size="sm" disabled={busy || !complete(provider, fields)}>
            {busy ? <><Spinner size={11} /> Connecting</> : `Connect ${PROVIDER_NAME[provider]}`}
          </Button>
        </div>
      </Card>
    </form>
  );
}
