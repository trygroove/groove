/**
 * A lesson as it runs (GRV-43): which chapter and bite, the step under way
 * and the world it started from, and what each transition tells Coproducer.
 * Pure: the editor's hook (`src/editor/assistant/useLesson.ts`) holds the
 * state, feeds it the world as the project, the view and the transport
 * change, and acts on what comes back.
 *
 * A bite runs its applicable steps in order. A step ends when its predicate
 * holds (done by the producer, or by Show me), or when the producer skips
 * it. The bite ends with its last step, and how it ended is the worst of how
 * its steps did: any skip makes it skipped, any Show me makes it shown, and
 * otherwise the producer did it. The producer pulls the next bite; after the
 * chapter's last, the lesson is over.
 *
 * "Finish a track" (GRV-44) runs its chapters one after another: after a
 * chapter's last bite the producer pulls the next chapter, and after the last
 * chapter's, the lesson is over. As each of its chapters starts, the bites
 * the song already has are passed over (`track.ts`).
 */

import { describeChanges } from "./changes";
import { chapter, nextStep } from "./chapters";
import { plainInstruction } from "./glossary";
import {
  type BiteEnding,
  type BiteId,
  type ChapterId,
  isTrackChapterId,
  type TrackChapterId,
} from "./ids";
import { madeBites, nextTrackChapter } from "./track";
import type { LessonBite, LessonChapter, LessonSettings, LessonWorld } from "./types";

/** The step under way. */
export interface LessonStepState {
  readonly index: number;
  /** Its instruction, read as it started (`LessonStep.instruction`). */
  readonly instruction: string;
  /** The world as it started, which its predicate and the changes read. */
  readonly start: LessonWorld;
  /** Whether Show me was pressed on it. */
  readonly shown: boolean;
}

export interface LessonState {
  readonly chapter: ChapterId;
  readonly biteIndex: number;
  /** Null once the bite is over: the producer pulls the next. */
  readonly step: LessonStepState | null;
  /** The world as the bite started, for what it changed altogether. */
  readonly biteStart: LessonWorld;
  /** How the bite's steps have ended so far. */
  readonly stepEndings: readonly BiteEnding[];
  /** How each bite of the chapter ended, this time through. */
  readonly endings: Readonly<Partial<Record<BiteId, BiteEnding>>>;
  /** Whether this is "Finish a track" (GRV-44), whose chapters follow one another. */
  readonly track: boolean;
  /**
   * The chapter's bites passed over because the song already had them, as
   * the chapter started (GRV-44). Empty outside "Finish a track".
   */
  readonly passed: readonly BiteId[];
}

/** What happened, for Coproducer and analytics. */
export type LessonEvent =
  | {
      readonly kind: "bite_started";
      /**
       * The bites passed over on the way to this one, the song already having
       * them (GRV-44): earlier in its chapter, or whole chapters before it.
       */
      readonly passed: readonly BiteId[];
    }
  | { readonly kind: "step_done"; readonly how: BiteEnding; readonly changes: string[] }
  | {
      readonly kind: "bite_done";
      readonly how: BiteEnding;
      readonly changes: string[];
      /** Whether it was the chapter's last. */
      readonly chapterDone: boolean;
      /** Whether it was the last of "Finish a track" (GRV-44). */
      readonly trackDone: boolean;
    };

export interface LessonTransition {
  readonly state: LessonState;
  readonly event: LessonEvent;
}

export function chapterOf(state: LessonState): LessonChapter {
  return chapter(state.chapter);
}

export function biteOf(state: LessonState): LessonBite {
  const found = chapterOf(state).bites[state.biteIndex];
  if (!found)
    throw new RangeError(`Chapter "${state.chapter}" has no bite ${state.biteIndex}`);
  return found;
}

/** The index of the chapter's next bite to teach after `after`, or -1. */
function followingIndex(state: LessonState, after: number): number {
  const passed = new Set(state.passed);
  return chapterOf(state).bites.findIndex(
    (one, index) => index > after && !passed.has(one.id),
  );
}

/** The chapter's next bite to teach, once the one under way is over; null after its last. */
export function followingBite(state: LessonState): LessonBite | null {
  const index = followingIndex(state, state.biteIndex);
  return index < 0 ? null : chapterOf(state).bites[index];
}

/** Whether the chapter's last bite is over: nothing is left in it to pull. */
export function chapterFinished(state: LessonState): boolean {
  return state.step === null && followingIndex(state, state.biteIndex) < 0;
}

/** The chapter "Finish a track" goes on to once this one is over, or null. */
export function followingChapter(state: LessonState): TrackChapterId | null {
  return state.track && isTrackChapterId(state.chapter)
    ? nextTrackChapter(state.chapter)
    : null;
}

/** Whether "Finish a track"'s last bite is over (GRV-44). */
export function trackFinished(state: LessonState): boolean {
  return state.track && chapterFinished(state) && followingChapter(state) === null;
}

/** How a bite ended, from how its steps did. */
export function biteEnding(steps: readonly BiteEnding[]): BiteEnding {
  if (steps.includes("skipped")) return "skipped";
  if (steps.includes("show_me")) return "show_me";
  return "did_it";
}

function stepAt(
  lessonBite: LessonBite,
  world: LessonWorld,
  settings: LessonSettings,
  after: number,
): LessonStepState | null {
  const next = nextStep(lessonBite, world, settings, after);
  return next
    ? {
        index: next.index,
        instruction: next.step.instruction(world, settings),
        start: world,
        shown: false,
      }
    : null;
}

/** How a lesson goes on: a chapter alone, or "Finish a track"'s (GRV-44). */
interface Course {
  readonly track: boolean;
  readonly passed: readonly BiteId[];
  readonly endings: LessonState["endings"];
}

function startAt(
  chapterId: ChapterId,
  biteIndex: number,
  world: LessonWorld,
  settings: LessonSettings,
  course: Course,
  passedNow: readonly BiteId[],
): LessonTransition {
  const bites = chapter(chapterId).bites;
  return {
    state: {
      chapter: chapterId,
      biteIndex,
      step: stepAt(bites[biteIndex], world, settings, -1),
      biteStart: world,
      stepEndings: [],
      endings: course.endings,
      track: course.track,
      passed: course.passed,
    },
    event: { kind: "bite_started", passed: passedNow },
  };
}

/**
 * Starts bite `biteId` of `chapterId` (its first, without one), keeping how
 * the chapter's earlier bites ended.
 */
export function startBite(
  chapterId: ChapterId,
  biteId: BiteId | null,
  world: LessonWorld,
  settings: LessonSettings,
  endings: LessonState["endings"] = {},
): LessonTransition {
  const bites = chapter(chapterId).bites;
  const found = biteId === null ? 0 : bites.findIndex((one) => one.id === biteId);
  return startAt(
    chapterId,
    Math.max(0, found),
    world,
    settings,
    { track: false, passed: [], endings },
    [],
  );
}

/**
 * Starts "Finish a track" (GRV-44) at chapter `chapterId`, at bite `biteId`
 * (its first, without one), passing over what the song already has: a bite
 * it has, and a chapter it has all of, the lesson going on to the next. Null
 * when the song has everything from there on.
 */
export function startTrack(
  chapterId: TrackChapterId,
  biteId: BiteId | null,
  world: LessonWorld,
  settings: LessonSettings,
  passedBefore: readonly BiteId[] = [],
): LessonTransition | null {
  const bites = chapter(chapterId).bites;
  const passed = madeBites(chapterId, world, settings);
  const skip = new Set(passed);
  const from = Math.max(
    0,
    biteId === null ? 0 : bites.findIndex((one) => one.id === biteId),
  );
  const index = bites.findIndex((one, at) => at >= from && !skip.has(one.id));
  if (index < 0) {
    const next = nextTrackChapter(chapterId);
    const all = [
      ...passedBefore,
      ...bites
        .slice(from)
        .map((one) => one.id)
        .filter((id) => skip.has(id)),
    ];
    return next ? startTrack(next, null, world, settings, all) : null;
  }
  const passedNow = [...passedBefore, ...bites.slice(from, index).map((one) => one.id)];
  return startAt(
    chapterId,
    index,
    world,
    settings,
    { track: true, passed, endings: {} },
    passedNow,
  );
}

/**
 * The next bite, once the one before is over: the chapter's next not passed
 * over, or in "Finish a track", the next chapter's first after its last.
 * Null when there is none.
 */
export function startNextBite(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition | null {
  if (state.step !== null) return null;
  const index = followingIndex(state, state.biteIndex);
  if (index >= 0) {
    const bites = chapterOf(state).bites;
    return startAt(
      state.chapter,
      index,
      world,
      settings,
      state,
      bites.slice(state.biteIndex + 1, index).map((one) => one.id),
    );
  }
  const next = followingChapter(state);
  return next ? startTrack(next, null, world, settings) : null;
}

/** Ends the step under way as `how`, and starts the next or ends the bite. */
function endStep(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
  how: BiteEnding,
): LessonTransition | null {
  const current = state.step;
  if (!current) return null;
  const lessonBite = biteOf(state);
  const stepEndings = [...state.stepEndings, how];
  const changes = describeChanges(current.start.project, world.project);
  const next = stepAt(lessonBite, world, settings, current.index);
  if (next) {
    return {
      state: { ...state, step: next, stepEndings },
      event: { kind: "step_done", how, changes },
    };
  }
  const ending = biteEnding(stepEndings);
  const ended: LessonState = {
    ...state,
    step: null,
    stepEndings,
    endings: { ...state.endings, [lessonBite.id]: ending },
  };
  return {
    state: ended,
    event: {
      kind: "bite_done",
      how: ending,
      changes: describeChanges(state.biteStart.project, world.project),
      chapterDone: chapterFinished(ended),
      trackDone: trackFinished(ended),
    },
  };
}

/**
 * Reads `world` against the step under way: once its predicate holds, the
 * step is done, by Show me if that was pressed on it. Null while it is not.
 */
export function observe(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition | null {
  const current = state.step;
  if (!current) return null;
  const step = biteOf(state).steps[current.index];
  if (!step.done(world, current.start, settings)) return null;
  return endStep(state, world, settings, current.shown ? "show_me" : "did_it");
}

/** Skip: the step under way ends unfinished, and the lesson moves on. */
export function skip(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition | null {
  return endStep(state, world, settings, "skipped");
}

/** Notes that Show me was pressed on the step under way. */
export function markShown(state: LessonState): LessonState {
  return state.step ? { ...state, step: { ...state.step, shown: true } } : state;
}

/** The plain words of the step under way, as Coproducer is told them. */
export function stepWords(state: LessonState): string | null {
  return state.step ? plainInstruction(state.step.instruction) : null;
}
