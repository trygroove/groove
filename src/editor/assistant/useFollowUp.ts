/**
 * When the assistant follows up after an Apply (GRV-195). Applying a proposal
 * starts one assistant turn by itself, so the producer is not left with
 * nothing to do next; dismissing one starts nothing.
 *
 * - **Coalesced.** Each Apply waits {@link FOLLOW_UP_DELAY_MS} of quiet, and
 *   another Apply meanwhile starts the wait again, so a run of applies (the
 *   parts of one streamed proposal, one card after another) starts one
 *   follow-up, not one per Apply.
 * - **After the reply on its way.** A part applied while its turn still
 *   streams waits for that turn to end.
 * - **Not when the conversation moved on.** Any turn starting before it goes
 *   (the producer's own message, Refresh) sees the applied song already, so
 *   the follow-up is dropped. So is one whose applies were all undone.
 */
import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import { type Scheduler, timeoutScheduler } from "../../shared/scheduler";

/** How long after the last Apply the follow-up goes. */
export const FOLLOW_UP_DELAY_MS = 2000;

export interface UseFollowUpOptions {
  /** Whether a reply is on its way. Reactive. */
  readonly streaming: Accessor<boolean>;
  /** Starts the follow-up turn; returns whether it went. */
  send(): boolean;
  /** What times the quiet after an Apply; the real timers by default. */
  readonly scheduler?: Scheduler;
}

export interface FollowUp {
  /** A card's Apply committed. */
  applied(entryId: string): void;
  /** A card's change was undone, by whatever undid it. */
  undone(entryId: string): void;
  /** A turn started, so a follow-up still to come is not needed. */
  turnStarted(): void;
}

export function useFollowUp(options: UseFollowUpOptions): FollowUp {
  const scheduler = options.scheduler ?? timeoutScheduler;
  /** The cards applied since the last turn, still applied. */
  const applied = new Set<string>();
  let cancelTimer: (() => void) | null = null;
  /** The quiet after the last Apply is over. */
  let due = false;

  function reset() {
    cancelTimer?.();
    cancelTimer = null;
    due = false;
    applied.clear();
  }

  /** Sends the follow-up once its quiet is over and no reply is on its way. */
  function tryToSend(streaming: boolean) {
    if (!due || streaming) return;
    const wanted = applied.size > 0;
    reset();
    // The turn reads the conversation and the song as they are now.
    if (wanted) untrack(() => options.send());
  }

  // The reply that was on its way when the quiet ran out has ended. The one
  // reactive read is whether a reply streams; sending is the apply half's.
  createEffect(
    () => options.streaming(),
    (streaming) => {
      tryToSend(streaming);
    },
  );
  onCleanup(reset);

  return {
    applied(entryId) {
      applied.add(entryId);
      cancelTimer?.();
      due = false;
      cancelTimer = scheduler.schedule(() => {
        cancelTimer = null;
        due = true;
        // Outside any reactive scope: a timer reads the signal as it is now.
        tryToSend(options.streaming());
      }, FOLLOW_UP_DELAY_MS);
    },
    undone(entryId) {
      applied.delete(entryId);
    },
    turnStarted: reset,
  };
}
