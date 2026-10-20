/**
 * Coproducer's one nudge a day in the editor (GRV-25): when a returning producer
 * opens a project with Coproducer's panel open, Coproducer may offer one "Want to try…?",
 * at most once a day across every project, and dismissable. Opening the
 * editor with the panel closed, or before the day after onboarding, offers
 * nothing. While the conversation cannot be shown (the retention notice is
 * waiting for an answer, GRV-8), nothing is decided: the day is not spent on
 * a nudge nobody could see.
 *
 * Analytics: `cue_nudge_shown` once it is offered, and `cue_nudge_answered`
 * with whether they tried it or put it away.
 */
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import { localDay, nudgeDue, nudgeLesson } from "../../memory/nudge";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { type Clock, systemClock } from "../../shared/clock";
import type { AssistantConversation } from "./useAssistantConversation";

export interface CueNudge {
  /** The lesson on offer, or null while there is none. */
  readonly lesson: Accessor<string | null>;
  /** "Let's try it": asks Coproducer for it, as the producer's own message. */
  tryIt(): void;
  /** "Not today". */
  dismiss(): void;
}

export interface UseCueNudgeOptions {
  readonly profile: ProducerProfileStore;
  /** Whether the panel is open: read once, as the profile arrives. */
  readonly expanded: Accessor<boolean>;
  /**
   * Whether the conversation can be on screen: false while the retention
   * notice stands in for it (GRV-8). The nudge is decided once it is true.
   */
  readonly ready?: Accessor<boolean>;
  readonly conversation: Pick<AssistantConversation, "send" | "pendingAsk">;
  readonly analytics: () => Pick<Analytics, "log">;
  readonly clock?: Clock;
}

/** What "Let's try it" says to Coproducer. */
export function nudgeMessage(lesson: string): string {
  return `I'd like to try "${lesson}".`;
}

export function useCueNudge(options: UseCueNudgeOptions): CueNudge {
  const clock = options.clock ?? systemClock;
  const [lesson, setLesson] = createSignal<string | null>(null);
  let decided = false;

  // Decided once, as the profile first arrives and the conversation can be
  // shown: those are the reactive reads, and the panel and the question
  // waiting are read as they are at that moment. Offering it writes, so it is
  // the apply half's.
  createEffect(
    () =>
      options.profile.loaded() && (options.ready?.() ?? true)
        ? options.profile.profile()
        : undefined,
    (profile) => {
      if (profile === undefined || decided) return;
      decided = true;
      const now = clock.now();
      const open = untrack(() => options.expanded());
      const waiting = untrack(() => options.conversation.pendingAsk()) !== null;
      if (!profile || !open || waiting || !nudgeDue(profile, now)) return;
      setLesson(nudgeLesson(profile));
      options.analytics().log("cue_nudge_shown", {});
      const today = localDay(now);
      void options.profile.update((current) => ({ ...current, lastNudgeDay: today }));
    },
  );

  return {
    lesson,
    tryIt() {
      const offered = lesson();
      if (!offered) return;
      if (!options.conversation.send(nudgeMessage(offered))) return;
      setLesson(null);
      options.analytics().log("cue_nudge_answered", { how: "tried" });
    },
    dismiss() {
      if (!lesson()) return;
      setLesson(null);
      options.analytics().log("cue_nudge_answered", { how: "dismissed" });
    },
  };
}
