/**
 * Coproducer's one nudge a day in the editor (GRV-25): when a returning producer
 * opens a project with Coproducer's panel open, Coproducer may offer one "Want to try…?",
 * at most once a day across every project, and dismissable. Opening the
 * editor with the panel closed, or before the day after onboarding, offers
 * nothing. While the conversation cannot be shown (the account's retention
 * answer is still loading, GRV-8), nothing is decided: the day is not spent on
 * a nudge nobody could see.
 *
 * What it offers is the next lesson bite the producer has not been through
 * (GRV-43), and "Let's try it" starts that bite in the panel.
 *
 * Analytics: `cue_nudge_shown` once it is offered, and `cue_nudge_answered`
 * with whether they tried it or put it away; `lesson_nudge_shown` and
 * `lesson_nudge_taken` with the bite's chapter and ID.
 */
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { LessonBite } from "../../lessons/types";
import { localDay, nudgeBite, nudgeDue } from "../../memory/nudge";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { type Clock, systemClock } from "../../shared/clock";
import type { AssistantConversation } from "./useAssistantConversation";

export interface CueNudge {
  /** The bite on offer, or null while there is none. */
  readonly bite: Accessor<LessonBite | null>;
  /**
   * "Let's try it": starts the bite in the panel, or without a lesson to
   * start it in, asks Coproducer for it as the producer's own message.
   */
  tryIt(): void;
  /** "Not today". */
  dismiss(): void;
}

export interface UseCueNudgeOptions {
  readonly profile: ProducerProfileStore;
  /** Whether the panel is open: read once, as the profile arrives. */
  readonly expanded: Accessor<boolean>;
  /**
   * Whether the conversation can be on screen: false while the account's
   * retention answer loads (GRV-8). The nudge is decided once it is true.
   */
  readonly ready?: Accessor<boolean>;
  readonly conversation: Pick<AssistantConversation, "send" | "pendingAsk">;
  readonly analytics: () => Pick<Analytics, "log">;
  /**
   * Starts the bite on offer (GRV-43), and says whether it could; when it
   * cannot, "Let's try it" asks Coproducer for it instead.
   */
  readonly startLesson?: (bite: LessonBite) => boolean;
  readonly clock?: Clock;
}

/** What "Let's try it" says to Coproducer. */
export function nudgeMessage(lesson: string): string {
  return `I'd like to try "${lesson}".`;
}

export function useCueNudge(options: UseCueNudgeOptions): CueNudge {
  const clock = options.clock ?? systemClock;
  const [bite, setBite] = createSignal<LessonBite | null>(null);
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
      const offered = nudgeBite(profile);
      if (!offered) return;
      setBite(offered);
      const analytics = options.analytics();
      analytics.log("cue_nudge_shown", {});
      analytics.log("lesson_nudge_shown", {
        chapter_id: offered.chapter,
        bite_id: offered.id,
      });
      const today = localDay(now);
      void options.profile.update((current) => ({ ...current, lastNudgeDay: today }));
    },
  );

  return {
    bite,
    tryIt() {
      const offered = bite();
      if (!offered) return;
      const started = options.startLesson?.(offered) ?? false;
      if (!started && !options.conversation.send(nudgeMessage(offered.title))) return;
      setBite(null);
      const analytics = options.analytics();
      analytics.log("cue_nudge_answered", { how: "tried" });
      analytics.log("lesson_nudge_taken", {
        chapter_id: offered.chapter,
        bite_id: offered.id,
      });
    },
    dismiss() {
      if (!bite()) return;
      setBite(null);
      options.analytics().log("cue_nudge_answered", { how: "dismissed" });
    },
  };
}
