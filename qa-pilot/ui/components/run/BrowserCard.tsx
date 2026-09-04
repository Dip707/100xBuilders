import { fileUrl } from "@/lib/api";
import { Card } from "@/components/ui";
import { latestScreenshotPath } from "@/lib/derive";
import type { RunEvent } from "@/lib/events";

export function BrowserCard({ events, runId }: { events: RunEvent[]; runId: string }) {
  const rel = latestScreenshotPath(events, runId);
  return (
    <Card title="Browser">
      <div className="py-3">
        {rel ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API path, not a static asset Next can optimise
          <img src={fileUrl(runId, rel)} alt="Latest exploration screenshot" className="w-full rounded-box border border-line" />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-box bg-inset text-sm text-muted">no screenshot yet</div>
        )}
      </div>
    </Card>
  );
}
