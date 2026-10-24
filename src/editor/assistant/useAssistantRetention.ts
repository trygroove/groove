/**
 * The account's answer about keeping its assistant conversations (GRV-8),
 * held once per editor beside the conversation.
 *
 * The disclosure is available before the first message, not answered before
 * it (GRV-205, ADR 0007 decision 5 as amended): sending is never gated on
 * {@link AssistantRetention.answered}. Until the account has answered the
 * current disclosure, the panel shows a one-line note under the composer; an
 * answer the browser could not load counts as no answer, so the note shows
 * rather than being skipped. Until the answer is known
 * ({@link AssistantRetention.known}) the note is not shown, so an account that
 * has answered never sees it flash past.
 *
 * Nothing loads until the assistant is first opened
 * ({@link UseAssistantRetentionOptions.wanted}): an editor whose assistant
 * stays shut never calls the callable.
 *
 * Giving an answer logs `assistant_retention_changed` with the answer only,
 * once it is stored. Analytics failing changes nothing here: the answer is
 * stored first, and the event is best-effort after it.
 */
import { type Accessor, createEffect, createSignal } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { RetentionState } from "../../assistant/retention";
import {
  type AssistantRetentionClient,
  answered as isAnswered,
} from "../../assistant/retentionClient";
import type {
  ProposalOutcome,
  ReplyRating,
  TranscriptIssue,
} from "../../assistant/transcripts";

export type RetentionStatus = "idle" | "loading" | "ready" | "failed";

export interface AssistantRetention {
  /** Where loading the account's answer is. */
  readonly status: Accessor<RetentionStatus>;
  /**
   * Whether loading the answer has finished, either way: false before the
   * first load and while one is in flight.
   */
  readonly known: Accessor<boolean>;
  /** Whether the account has answered the disclosure on screen. */
  readonly answered: Accessor<boolean>;
  /** The answer: keep, don't, or `null` before one is known. */
  readonly retain: Accessor<boolean | null>;
  /** Whether an answer is being saved. */
  readonly saving: Accessor<boolean>;
  /** Whether the last save failed. */
  readonly saveFailed: Accessor<boolean>;
  /** Loads the answer again, after a failure. */
  reload(): void;
  /**
   * Notes that the producer opened the full disclosure from the composer's
   * note (GRV-205): `feature_first_use` for `assistant_disclosure`.
   */
  disclosureOpened(): void;
  /** Gives an answer. Resolves with whether it was stored. */
  answer(retain: boolean): Promise<boolean>;
  /** Tells a kept turn what became of its proposal, if the account keeps any. */
  reportOutcome(
    turnId: string,
    outcome: ProposalOutcome,
    issues?: readonly TranscriptIssue[],
  ): void;
  /**
   * Tells a kept turn how the producer rated its reply, or that the rating
   * was cleared (GRV-103), if the account keeps any.
   */
  reportRating(turnId: string, rating: ReplyRating | null): void;
}

export interface UseAssistantRetentionOptions {
  readonly client: () => Promise<AssistantRetentionClient>;
  /** Whether a signed-in account is here; nothing loads for anyone else. */
  readonly registered: Accessor<boolean>;
  readonly analytics: () => Analytics;
  /**
   * Whether the answer is needed yet: the editor passes "the assistant is
   * open", and the first time it is true for a signed-in account the answer
   * loads. Later closes do not unload it. Always needed when left out.
   */
  readonly wanted?: Accessor<boolean>;
}

export function useAssistantRetention(
  options: UseAssistantRetentionOptions,
): AssistantRetention {
  const [state, setState] = createSignal<RetentionState | null>(null);
  const [status, setStatus] = createSignal<RetentionStatus>("idle");
  const [saving, setSaving] = createSignal(false);
  const [saveFailed, setSaveFailed] = createSignal(false);
  let generation = 0;
  /**
   * The rating each turn is to end up with, while a call for it is on its
   * way (GRV-103). Calls for one turn go one at a time, the latest rating
   * once the one before settles, so quick clicks cannot land out of order.
   */
  const ratingsDue = new Map<string, { rating: ReplyRating | null; due: boolean }>();

  async function sendRatings(
    turnId: string,
    slot: { rating: ReplyRating | null; due: boolean },
  ) {
    while (slot.due) {
      slot.due = false;
      const rating = slot.rating;
      try {
        const client = await options.client();
        await client.rate(turnId, rating);
      } catch {
        // Best-effort, like an outcome: the rating on screen stands.
      }
    }
    ratingsDue.delete(turnId);
  }

  function load(): void {
    generation += 1;
    const mine = generation;
    setStatus("loading");
    options
      .client()
      .then((client) => client.get())
      .then(
        (next) => {
          if (mine !== generation) return;
          setState(next);
          setStatus("ready");
        },
        () => {
          if (mine !== generation) return;
          setState(null);
          setStatus("failed");
        },
      );
  }

  // Whether this account's answer has been asked for; a sign-out resets it.
  let requested = false;
  // The account and whether the answer is wanted are the two reactive reads;
  // loading writes, so it is the apply half's.
  createEffect(
    () => ({ registered: options.registered(), wanted: options.wanted?.() ?? true }),
    ({ registered, wanted }) => {
      if (!registered) {
        requested = false;
        generation += 1;
        setState(null);
        setStatus("idle");
      } else if (wanted && !requested) {
        requested = true;
        load();
      }
    },
  );

  const answered = () => options.registered() && isAnswered(state());

  return {
    status,
    known: () => status() === "ready" || status() === "failed",
    answered,
    retain: () => (isAnswered(state()) ? (state()?.preference?.retain ?? null) : null),
    saving,
    saveFailed,
    reload: load,
    disclosureOpened() {
      try {
        options.analytics().logFeatureFirstUse("assistant_disclosure");
      } catch {
        // Best-effort, like the answer's own events.
      }
    },
    async answer(retain) {
      if (saving()) return false;
      setSaving(true);
      setSaveFailed(false);
      try {
        const client = await options.client();
        const next = await client.set(retain);
        generation += 1;
        setState(next);
        setStatus("ready");
      } catch {
        setSaveFailed(true);
        return false;
      } finally {
        setSaving(false);
      }
      try {
        const analytics = options.analytics();
        analytics.log("assistant_retention_changed", { state: retain ? "on" : "off" });
        analytics.logFeatureFirstUse("assistant_retention");
      } catch {
        // The answer is stored; an analytics failure is not this feature's.
      }
      return true;
    },
    reportOutcome(turnId, outcome, issues) {
      if (state()?.preference?.retain !== true) return;
      void options
        .client()
        .then((client) => client.outcome(turnId, outcome, issues))
        .catch(() => {});
    },
    reportRating(turnId, rating) {
      if (state()?.preference?.retain !== true) return;
      const sending = ratingsDue.get(turnId);
      if (sending) {
        // Sent as soon as the call on its way settles, in place of any other
        // change still waiting.
        sending.rating = rating;
        sending.due = true;
        return;
      }
      const slot = { rating, due: true };
      ratingsDue.set(turnId, slot);
      void sendRatings(turnId, slot);
    },
  };
}
