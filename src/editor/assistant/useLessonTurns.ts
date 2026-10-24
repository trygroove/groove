/**
 * A lesson's turns to Coproducer (GRV-43, GRV-190): each transition is one
 * turn (`sendLesson`), which Coproducer answers with the words a lesson
 * needs. A turn that cannot go yet (a reply is still on its way) waits;
 * turns that wait together go as one (`foldTurns`), the newest carrying the
 * others, so a bite finished while Coproducer was still writing is still
 * celebrated.
 *
 * A transition is sent once: the same transition queued again (one Skip
 * handled twice) is dropped, so one press is one turn.
 */
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import { cueMessage, foldTurns, type LessonTurn, lessonCue } from "../../lessons/cue";
import { chapterOf, type LessonEvent, type LessonState } from "../../lessons/session";
import type { LessonSettings } from "../../lessons/types";
import type { AssistantConversation } from "./useAssistantConversation";

export interface UseLessonTurnsOptions {
  readonly conversation: Pick<AssistantConversation, "sendLesson" | "streaming">;
  readonly settings: Accessor<LessonSettings>;
  /** Every bite the producer has done, for the wrap-up's pointers. */
  readonly done: Accessor<readonly string[]>;
}

export interface LessonTurns {
  /** Queues the turn for `event`, which left the lesson at `state`. */
  queue(state: LessonState, event: LessonEvent): void;
  /** Drops every turn still waiting. */
  clear(): void;
}

interface PendingTurn extends LessonTurn {
  /** The chapter the log shows the turn under. */
  readonly label: string;
}

/** What makes a transition the same one: where it left the lesson, and what happened. */
export function transitionKey(state: LessonState, event: LessonEvent): string {
  const how = event.kind === "bite_started" ? "" : event.how;
  return [
    state.lessonId,
    state.chapterIndex,
    state.biteIndex,
    state.step?.index ?? "over",
    event.kind,
    how,
  ].join("|");
}

export function useLessonTurns(options: UseLessonTurnsOptions): LessonTurns {
  // The turns waiting for a reply to finish, oldest first.
  const [pending, setPending] = createSignal<readonly PendingTurn[]>([]);
  let lastKey: string | null = null;

  // A lesson's turn goes as soon as no reply is on its way; the turns that
  // waited for one go together, as the newest carrying the rest.
  createEffect(
    () => ({ waiting: pending(), busy: options.conversation.streaming() }),
    ({ waiting, busy }) => {
      const [first, ...rest] = waiting;
      if (!first || busy) return;
      const turn = foldTurns([first, ...rest]);
      const label = waiting[waiting.length - 1]?.label ?? first.label;
      // Sending reads the conversation as it stands; it is not what this waits on.
      const sent = untrack(() =>
        options.conversation.sendLesson(turn.text, turn.cue, label),
      );
      // Only what went is taken off: a turn queued meanwhile waits on.
      if (sent) setPending((now) => now.slice(waiting.length));
    },
  );

  return {
    queue(state, event) {
      const key = transitionKey(state, event);
      if (key === lastKey) return;
      lastKey = key;
      const turn: PendingTurn = {
        text: cueMessage(state, event),
        cue: lessonCue(state, event, untrack(options.settings), untrack(options.done)),
        label: chapterOf(state).title,
      };
      setPending((waiting) => [...waiting, turn]);
    },
    clear() {
      lastKey = null;
      setPending([]);
    },
  };
}
