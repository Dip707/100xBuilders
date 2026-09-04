"use client";
import { Suspense } from "react";
import { useParams } from "next/navigation";
import { RunProvider, useRun } from "@/lib/run-context";
import { TestDetail } from "@/components/test/TestDetail";
import { ReviewModal } from "@/components/review/ReviewModal";
import { Spinner } from "@/components/ui";

function Overlays() {
  const { awaitingReview } = useRun();
  return (
    <>
      <TestDetail />
      {awaitingReview && <ReviewModal />}
    </>
  );
}

/**
 * Everything under /runs/[id] shares one run subscription, one detail drawer (opened via
 * ?test=<id> from any of the three screens) and the review sheet, which takes over the
 * screen whenever the run is parked at the plan-review gate.
 */
export default function RunLayout({ children }: { children: React.ReactNode }) {
  const runId = String(useParams().id);
  return (
    <Suspense fallback={<div className="flex justify-center p-16"><Spinner size={22} /></div>}>
      <RunProvider runId={runId}>
        {children}
        <Overlays />
      </RunProvider>
    </Suspense>
  );
}
