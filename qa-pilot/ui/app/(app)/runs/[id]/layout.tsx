"use client";
import { useRun } from "@/lib/run-context";
import { TestDetail } from "@/components/test/TestDetail";
import { ReviewModal } from "@/components/review/ReviewModal";

/**
 * The overlays every run screen shares: the detail drawer, opened via ?test=<id> from any
 * of the four screens, and the review sheet, which takes over whenever the run is parked at
 * the plan-review gate.
 *
 * The run subscription itself lives in the app shell (see `(app)/layout.tsx`), one level up,
 * so the sidebar can badge each stage from the same stream these screens render.
 */
export default function RunLayout({ children }: { children: React.ReactNode }) {
  const { awaitingReview } = useRun();
  return (
    <>
      {children}
      <TestDetail />
      {awaitingReview && <ReviewModal />}
    </>
  );
}
