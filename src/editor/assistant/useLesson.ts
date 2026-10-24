/**
 * The lesson under way in the assistant's panel (GRV-43, GRV-190): which
 * lesson, chapter and bite, the step and where to act, and what Show me,
 * Skip, Next and Leave do. This holds the state and wires it up; the lesson
 * itself is pure (`src/lessons/session.ts`), and the rest is in its own
 * hooks: the project's lesson record (`useLessonRecord.ts`), the turns to
 * Coproducer (`useLessonTurns.ts`), Show me (`useLessonShowMe.ts`) and
 * when and from where a lesson starts (`useLessonStart.ts`).
 *
 * - **Where it stands** is the project's lesson record, written on every
 *   transition, so a reload, another tab or another device brings the card
 *   back at the same step. A lesson that ended or was left is under way no
 *   more; the bites it finished stay finished.
 *
 * Analytics: `lesson_bite_started` (where from), `lesson_bite_completed`
 * (how), `lesson_chapter_completed` and `lesson_track_completed` (GRV-44),
 * `lesson_dropped_out` and `feature_first_use` `lessons`, by chapter and bite
 * ID only.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createFactoryContext } from "../../domain/factories";
import { lessonCue } from "../../lessons/cue";
import type { LessonSource } from "../../lessons/ids";
import {
  biteOf,
  type LessonState,
  type LessonTransition,
  observe,
  skip as skipStep,
  startNextBite,
} from "../../lessons/session";
import { beatStyleFor } from "../../lessons/style";
import type { LessonSettings } from "../../lessons/types";
import { logStarted, logTransition } from "./lessonAnalytics";
import type { Lesson, UseLessonOptions } from "./lessonTypes";
import { lessonWorld } from "./useLessonListening";
import { useLessonRecord } from "./useLessonRecord";
import { useLessonShowMe } from "./useLessonShowMe";
import { useLessonStart } from "./useLessonStart";
import { useLessonTurns } from "./useLessonTurns";

export type { Lesson, UseLessonOptions } from "./lessonTypes";

export function useLesson(options: UseLessonOptions): Lesson {
  const [state, setState] = createSignal<LessonState | null>(null);
  const factory = options.factoryContext ?? (() => createFactoryContext());
  const record = options.record ?? useLessonRecord({ owner: () => null });
  const settings = createMemo(
    (): LessonSettings => ({
      style: beatStyleFor(options.profile?.profile()?.memory.taste ?? []),
    }),
  );
  const done = createMemo((): readonly string[] => [
    ...new Set([...(options.profile?.profile()?.lessonsDone ?? []), ...record.done()]),
  ]);

  const world = () =>
    lessonWorld(options.project(), options.view(), options.playing(), options.listening);

  const turns = useLessonTurns({ conversation: options.conversation, settings, done });
  const shows = useLessonShowMe({
    state,
    setState,
    world,
    settings,
    view: options.view,
    playing: options.playing,
    editor: options.editor,
    registry: options.registry,
    factory,
  });
  function handle({ state: next, event }: LessonTransition): void {
    shows.clearNotice();
    logTransition(options.analytics(), next, event);
    // The lesson's last bite ends it: the wrap-up follows in the conversation.
    const over = event.kind === "bite_done" && event.lessonDone;
    record.save(
      over ? null : next,
      event.kind === "bite_done"
        ? { biteId: biteOf(next).id, how: event.how }
        : undefined,
    );
    turns.queue(next, event);
    setState(over ? null : next);
    if (event.kind === "step_done") shows.arrive(next);
  }

  function begin(transition: LessonTransition, source: LessonSource): void {
    shows.clearNotice();
    setState(transition.state);
    record.save(transition.state);
    logStarted(options.analytics(), transition.state, source);
    turns.queue(transition.state, transition.event);
    shows.arrive(transition.state);
  }

  // The step under way is read against the world as it changes: once its
  // predicate holds, it is done. Ending the step writes, so it is the apply half's.
  createEffect(
    () => ({ current: state(), now: world() }),
    ({ current, now }) => {
      if (!current || !now) return;
      const transition = observe(current, now, untrack(settings));
      if (transition) handle(transition);
    },
  );

  const starts = useLessonStart({
    record,
    world,
    settings,
    current: state,
    restore: (back) => setState(back),
    begin,
    analytics: options.analytics,
  });

  return {
    state,
    finished: record.finished,
    notice: shows.notice,
    canShowMe: options.editor !== undefined,
    start: starts.start,
    next() {
      const current = state();
      const now = world();
      const transition = current && now && startNextBite(current, now, settings());
      if (transition) begin(transition, "next");
    },
    upcoming() {
      const current = state();
      const now = world();
      if (!current || !now) return null;
      return startNextBite(current, now, settings())?.state ?? null;
    },
    showMe: shows.showMe,
    skip() {
      const current = state();
      const now = world();
      const transition = current && now && skipStep(current, now, settings());
      if (transition) handle(transition);
    },
    leave() {
      starts.forget();
      if (!state()) return;
      starts.dropOut();
      turns.clear();
      shows.clearNotice();
      setState(null);
      record.save(null);
    },
    context() {
      const current = state();
      return current ? lessonCue(current, null, settings(), done()) : null;
    },
  };
}
