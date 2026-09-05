import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationsCard } from "@/components/settings/IntegrationsCard";

const noop = async () => {};
const handlers = { onConnect: noop, loadDestinations: async () => [], onPickDestination: noop, onDisconnect: noop };
const ACTIVE = { provider: "linear" as const, status: "active" as const, destination: { id: "t1", label: "Engineering (ENG)" }, label: "Linear · Engineering (ENG)", connectedAt: "2026-09-05T10:00:00.000Z" };

describe("IntegrationsCard", () => {
  it("offers both trackers and promises no credential is typed here", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={null} {...handlers} />);
    expect(html).toContain("Connect Linear");
    expect(html).toContain("Connect Jira");
    expect(html).toContain("never sees a password or an API key");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Disconnect");
  });

  it("says when the last attempt did not finish", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={{ ...ACTIVE, status: "pending", destination: undefined, label: "Linear" }} {...handlers} />);
    expect(html).toContain("did not finish");
    expect(html).toContain("Connect Linear");
  });

  it("asks for a destination once the tracker has answered", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={{ ...ACTIVE, destination: undefined, label: "Linear" }} {...handlers} />);
    expect(html).toContain("Pick the team");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect Linear");
  });

  it("shows the connection, the destination, Disconnect and the way back once complete", () => {
    const html = renderToStaticMarkup(<IntegrationsCard integration={ACTIVE} returnTo="/copilot?chat=abc" {...handlers} />);
    expect(html).toContain("Linear · Engineering (ENG)");
    expect(html).toContain("Engineering (ENG) in Linear");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Back to the copilot");
    expect(html).toContain('href="/copilot?chat=abc"');
    expect(renderToStaticMarkup(<IntegrationsCard integration={ACTIVE} {...handlers} />)).not.toContain("Back to the copilot");
  });

  it("renders a callback error and a loading state", () => {
    expect(renderToStaticMarkup(<IntegrationsCard integration={null} error="Linear did not authorise the connection" {...handlers} />)).toContain("did not authorise");
    const loading = renderToStaticMarkup(<IntegrationsCard integration={undefined} {...handlers} />);
    expect(loading).toContain('aria-label="loading"');
    expect(loading).not.toContain("Connect Linear");
  });
});
