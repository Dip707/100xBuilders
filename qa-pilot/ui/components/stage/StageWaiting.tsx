"use client";
import Link from "next/link";
import { Button, Icon, Wallpaper } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { stageHref, waitingOn, type StageId } from "@/lib/stages";

/**
 * What a stage screen shows before its stage has run.
 *
 * Every workspace screen stays reachable at every point in a run, so each one has to be
 * able to say for itself that it has nothing yet, name the stage actually holding things
 * up, and offer a way there. A greyed-out rail item would have been less work and would
 * have left the user with a dead end and no explanation.
 */
export function StageWaiting({ id }: { id: StageId }) {
  const { runId, stages } = useRun();
  const stage = stages.find((s) => s.id === id)!;
  const blocker = waitingOn(stages, id);
  const over = stage.status === "not_run";

  return (
    <div className="relative isolate flex flex-col items-center gap-3 overflow-hidden px-6 py-24 text-center">
      {/* The waiting screen owns its own plate: it is empty, which is where the wallpapers belong. */}
      <Wallpaper name="loupe" className="h-full opacity-40 [mask-image:radial-gradient(90%_80%_at_50%_35%,#000_0%,transparent_75%)]" />
      <span className="flex size-11 items-center justify-center rounded-box border border-line bg-inset text-subtle">
        <Icon name={over ? "minus" : "dashedCircle"} size={19} className={over ? "" : "animate-spin [animation-duration:2.4s]"} />
      </span>
      <p className="text-[11px] font-medium uppercase tracking-[0.6px] text-subtle">{over ? "Not run" : "Not started"}</p>
      <h3 className="text-[15px] font-medium tracking-[0.2px] text-fg">{stage.label}</h3>
      <p className="max-w-md text-[13px] leading-relaxed text-muted">
        {stage.blurb}{" "}
        {over
          ? "This run ended before it got here."
          : blocker
            ? <>Waiting on <span className="text-fg">{blocker.label}</span>.</>
            : "Starting shortly."}
      </p>
      {blocker && (
        <div className="pt-1">
          <Link href={stageHref(runId, blocker.id)}>
            <Button variant="outline" size="sm">
              <Icon name={blocker.icon} size={13} /> Go to {blocker.label}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
