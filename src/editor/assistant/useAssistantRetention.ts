/**
 * The account's answer about keeping its assistant conversations (GRV-8),
 * held once per editor beside the conversation.
 *
 * Until a signed-in account has answered the current disclosure, the
 * assistant cannot be messaged: `useAssistantChat` gates sending on
 * {@link AssistantRetention.answered}, and the panel shows the disclosure in
 * place of the composer. An answer the browser could not load counts as no
 * answer, so the disclosure is shown again rather than skipped. Until the
 * answer is known ({@link AssistantRetention.known}), the panel shows neither
 * the disclosure nor the conversation, so an account that has answered never
 * sees the disclosure flash past.
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
import type { ProposalOutcome } from "../../assistant/transcripts";

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
  /** Gives an answer. Resolves with whether it was stored. */
  answer(retain: boolean): Promise<boolean>;
  /** Tells a kept turn what became of its proposal, if the account keeps any. */
  reportOutcome(turnId: string, outcome: ProposalOutcome): void;
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
    reportOutcome(turnId, outcome) {
      if (state()?.preference?.retain !== true) return;
      void options
        .client()
        .then((client) => client.outcome(turnId, outcome))
        .catch(() => {});
    },
  };
}
