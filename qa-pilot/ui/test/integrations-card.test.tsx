import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationsCard } from "@/components/settings/IntegrationsCard";

const noop = async () => {};

describe("IntegrationsCard", () => {
  it("offers Linear's fields by default, with the key masked", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={null} onConnect={noop} onDisconnect={noop} />);
    expect(html).toContain("API key");
    expect(html).toContain("Team key");
    expect(html).toContain('type="password"');
    expect(html).toContain("Connect Linear");
    expect(html).not.toContain("Site URL");
  });

  it("offers Jira's fields when Jira is chosen", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={null} onConnect={noop} onDisconnect={noop} initialProvider="jira" />);
    expect(html).toContain("Site URL");
    expect(html).toContain("Email");
    expect(html).toContain("API token");
    expect(html).toContain("Project key");
    expect(html).toContain("Connect Jira");
  });

  it("shows the connection and a Disconnect button, never a field, once connected", () => {
    const html = renderToStaticMarkup(
      <IntegrationsCard integration={{ provider: "linear", label: "Linear · Engineering", connectedAt: "2026-09-05T10:00:00.000Z" }} onConnect={noop} onDisconnect={noop} />,
    );
    expect(html).toContain("Linear · Engineering");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("API key");
  });

  it("shows a loading state until the connection is known", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={undefined} onConnect={noop} onDisconnect={noop} />);
    expect(html).toContain('aria-label="loading"');
    expect(html).not.toContain("Connect Linear");
  });
});
