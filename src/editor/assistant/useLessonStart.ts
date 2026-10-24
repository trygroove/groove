/**
 * How a lesson starts (GRV-190), beside the project's lesson record: the
 * lesson the record has under way comes back once the record has been read,
 * a lesson asked for before then waits for the read and starts from it, and
 * a lesson started over another one under way drops out of that one first.
 * `useLesson.ts` holds the state; this decides when and from where it starts.
 *
 * Analytics: `lesson_dropped_out` for the lesson a start replaces, the one
 * on screen or the one the record had under way, by chapter and bite ID only.
 */
import { type Accessor, createEffect, untrack } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import {
  type BiteId,
  isLessonId,
  type LessonId,
  type LessonSource,
} from "../../lessons/ids";
import {
  type LessonState,
  type LessonTransition,
  startLesson,
} from "../../lessons/session";
import type { LessonSettings, LessonWorld } from "../../lessons/types";
import { lessonIds } from "./lessonAnalytics";
import type { LessonRecordStore, LoadedLessonRecord } from "./useLessonRecord";

export interface UseLessonStartOptions {
  readonly record: LessonRecordStore;
  readonly world: () => LessonWorld | null;
  readonly settings: Accessor<LessonSettings>;
  /** The lesson under way as it stands now, or null outside one. */
  readonly current: () => LessonState | null;
  /** Puts the lesson the record had under way back, silently. */
  readonly restore: (state: LessonState) => void;
  /** Begins the lesson `transition` starts, as started from `source`. */
  readonly begin: (transition: LessonTransition, source: LessonSource) => void;
  /** Hears that a start left the lesson under way for another. */
  readonly replaced?: () => void;
  readonly analytics: () => Pick<Analytics, "log">;
}

export interface LessonStart {
  /**
   * Starts `lesson` where the record has it, or from its first bite (at
   * `biteId` when given); whether it could (not while no project is open).
   * The lesson under way, asked for again with no bite, carries on where it
   * is. Asked for while the record is still being read, it waits for the read.
   */
  start(lesson: LessonId, source: LessonSource, biteId?: BiteId): boolean;
  /** Forgets a start still waiting for the record's read. */
  forget(): void;
  /** Logs the lesson under way, if any, as dropped out of. */
  dropOut(): void;
}

export function useLessonStart(options: UseLessonStartOptions): LessonStart {
  const { record, world, settings } = options;

  // A lesson asked for before the record has been read waits for it, so it
  // starts from where the record has it rather than from an empty one.
  let pending: {
    readonly lesson: LessonId;
    readonly source: LessonSource;
    readonly biteId?: BiteId;
  } | null = null;

  // The lesson the record has under way comes back once it has been read and
  // there is a project to read it against, silently: the conversation already
  // has its turns. Each record is read back once. A lesson asked for while it
  // was read starts instead, from it.
  let restored: string | null = null;
  createEffect(
    () => ({
      settled: record.settled(),
      loaded: record.loaded(),
      ready: world() !== null,
    }),
    ({ settled, loaded, ready }) => {
      if (!ready) return;
      if (pending && settled) {
        const asked = pending;
        pending = null;
        if (loaded) restored = loaded.key;
        // Another lesson the record had under way is left for this one.
        const stored = loaded && !options.current() ? storedLesson(loaded) : null;
        const replacing = stored?.lessonId === asked.lesson ? null : stored;
        launch(asked.lesson, asked.source, asked.biteId, replacing);
        return;
      }
      if (!loaded || restored === loaded.key) return;
      restored = loaded.key;
      if (options.current()) return;
      const back = storedLesson(loaded);
      if (back) options.restore(back);
    },
  );

  /** The lesson `loaded` has under way, read against the world as it stands. */
  function storedLesson(loaded: LoadedLessonRecord): LessonState | null {
    const underWay = loaded.record.underWay;
    const now = untrack(world);
    if (!underWay || !now || !isLessonId(underWay.lessonId)) return null;
    return (
      startLesson(underWay.lessonId, loaded.record, now, untrack(settings))?.state ?? null
    );
  }

  function launch(
    lesson: LessonId,
    source: LessonSource,
    biteId?: BiteId,
    replacing: LessonState | null = options.current(),
  ): boolean {
    const now = world();
    if (!now) return false;
    // The lesson under way, asked for again, carries on where it is.
    const current = options.current();
    if (biteId === undefined && current?.lessonId === lesson) return true;
    const transition = startLesson(lesson, record.current(), now, settings(), biteId);
    if (!transition) return false;
    dropOut(replacing);
    if (current) options.replaced?.();
    options.begin(transition, source);
    return true;
  }

  function dropOut(current: LessonState | null = options.current()): void {
    if (current) options.analytics().log("lesson_dropped_out", lessonIds(current));
  }

  return {
    start(lesson, source, biteId) {
      if (!world()) return false;
      if (!record.settled()) {
        pending = { lesson, source, biteId };
        return true;
      }
      return launch(lesson, source, biteId);
    },
    forget() {
      pending = null;
    },
    dropOut: () => dropOut(),
  };
}
