// Retries a save the connection dropped, on a timer (GRV-55).
//
// The browser's `online` event is not enough to bring a failed save back: it
// can say the page is online while nothing reaches Firestore (DevTools'
// offline throttling did exactly that in QA, as can a captive portal), and
// then never fire again when the connection really returns. So a write that
// failed in a way a retry could clear is tried again by itself, backing off,
// until it lands or fails for a reason no retry clears. Pressing Retry or
// coming back online only tries sooner.

import type { ProjectAutosave } from "../../persistence/autosave";
import type { Scheduler } from "../../shared/scheduler";

/** How long each consecutive retry waits; the last repeats. */
export const SAVE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** The wait before retry number `attempt` (0-based). */
export function saveRetryDelay(attempt: number): number {
  return SAVE_RETRY_DELAYS_MS[Math.min(attempt, SAVE_RETRY_DELAYS_MS.length - 1)];
}

/**
 * Keeps retrying `autosave`'s retryable failures until a write lands. Returns
 * the way to stop.
 */
export function retryFailedSaves(
  autosave: Pick<ProjectAutosave, "subscribe" | "flush">,
  scheduler: Scheduler,
): () => void {
  let attempt = 0;
  let cancel: (() => void) | null = null;
  const clear = () => {
    cancel?.();
    cancel = null;
  };
  const unsubscribe = autosave.subscribe((status) => {
    if (status.state === "saved") attempt = 0;
    // Anything but a fresh failure (an edit, a write starting) supersedes the
    // wait: the autosave writes again on its own schedule.
    clear();
    if (status.state !== "failed" || !status.failure?.retryable) return;
    cancel = scheduler.schedule(() => {
      cancel = null;
      void autosave.flush().catch(() => {
        // A failed write surfaces through the status, which schedules the next.
      });
    }, saveRetryDelay(attempt));
    attempt += 1;
  });
  return () => {
    clear();
    unsubscribe();
  };
}
