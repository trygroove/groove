/**
 * A lesson as it runs (GRV-43, GRV-190): which lesson, chapter and bite, the
 * step under way and the world it started from, and what each transition
 * tells Coproducer. Pure: the editor's hook (`src/editor/assistant/useLesson.ts`)
 * holds the state, feeds it the world as the project, the view and the
 * transport change, and acts on what comes back.
 *
 * A lesson is an ordered list of chapters (`LESSONS`), and there is one way
 * to start one, {@link startLesson}, which picks the position from the
 * project's lesson record: where the lesson under way was, or its first
 * bite. A position is never inferred from the bites finished.
 *
 * A bite runs its applicable steps in order. A step ends when its predicate
 * holds (done by the producer, or by Show me), or when the producer skips
 * it. The bite ends with its last step, and how it ended is the worst of how
 * its steps did: any skip makes it skipped, any Show me makes it shown, and
 * otherwise the producer did it. The producer pulls the next bite; after a
 * chapter's last, the next chapter, and after the last chapter's, the lesson
 * is over. In a lesson that builds on the song ("Finish a track", GRV-44), as
 * each chapter starts the bites the song already has are passed over.
 */

import type { LessonRecord } from "../persistence/lessonDocuments";
import { describeChanges } from "./changes";
import { chapter as chapterById, lesson, nextStep } from "./chapters";
import { plainInstruction } from "./glossary";
import {
  BITE_ENDINGS,
  type BiteEnding,
  type BiteId,
  type ChapterId,
  isBiteId,
  type LessonId,
} from "./ids";
import type {
  LessonBite,
  LessonChapter,
  LessonDefinition,
  LessonSettings,
  LessonWorld,
} from "./types";

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
  readonly lessonId: LessonId;
  /** The chapter under way, as its place in the lesson from 0. */
  readonly chapterIndex: number;
  readonly biteIndex: number;
  /** Null once the bite is over: the producer pulls the next. */
  readonly step: LessonStepState | null;
  /** The world as the bite started, for what it changed altogether. */
  readonly biteStart: LessonWorld;
  /** How the bite's steps have ended so far. */
  readonly stepEndings: readonly BiteEnding[];
  /** How each bite of the lesson ended, this time through. */
  readonly endings: Readonly<Partial<Record<BiteId, BiteEnding>>>;
  /**
   * The bites passed over because the song already had them, as each of the
   * lesson's chapters so far started (GRV-44). Empty in a lesson that teaches
   * every bite.
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
      /** Whether it was the lesson's last. */
      readonly lessonDone: boolean;
    };

export interface LessonTransition {
  readonly state: LessonState;
  readonly event: LessonEvent;
}

export function lessonOf(state: LessonState): LessonDefinition {
  return lesson(state.lessonId);
}

export function chapterOf(state: LessonState): LessonChapter {
  const found = lessonOf(state).chapters[state.chapterIndex];
  if (!found)
    throw new RangeError(
      `Lesson "${state.lessonId}" has no chapter ${state.chapterIndex}`,
    );
  return found;
}

export function biteOf(state: LessonState): LessonBite {
  const found = chapterOf(state).bites[state.biteIndex];
  if (!found)
    throw new RangeError(
      `Chapter "${chapterOf(state).id}" has no bite ${state.biteIndex}`,
    );
  return found;
}

/** Whether the lesson has several chapters, each told by its number. */
export function hasChapters(lessonId: LessonId): boolean {
  return lesson(lessonId).chapters.length > 1;
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

/** The lesson's chapter after the one under way, or null after its last. */
export function followingChapter(state: LessonState): LessonChapter | null {
  return lessonOf(state).chapters[state.chapterIndex + 1] ?? null;
}

/** Whether the lesson's last bite is over. */
export function lessonFinished(state: LessonState): boolean {
  return chapterFinished(state) && followingChapter(state) === null;
}

/** The bites of `chapterId` the song already has, as the chapter starts in `world`. */
export function madeBites(
  chapterId: ChapterId,
  world: LessonWorld,
  settings: LessonSettings,
): BiteId[] {
  return chapterById(chapterId)
    .bites.filter((one) => one.made?.(world, settings) ?? false)
    .map((one) => one.id);
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

interface Position {
  readonly lessonId: LessonId;
  readonly chapterIndex: number;
  readonly biteIndex: number;
  readonly endings: LessonState["endings"];
  readonly passed: readonly BiteId[];
}

function startAt(
  at: Position,
  world: LessonWorld,
  settings: LessonSettings,
  passedNow: readonly BiteId[],
): LessonTransition {
  const lessonBite = lesson(at.lessonId).chapters[at.chapterIndex].bites[at.biteIndex];
  return {
    state: {
      ...at,
      step: stepAt(lessonBite, world, settings, -1),
      biteStart: world,
      stepEndings: [],
    },
    event: { kind: "bite_started", passed: passedNow },
  };
}

/**
 * Starts chapter `chapterIndex` of `definition` at bite `from` (or the first
 * after it the song does not have, in a lesson that passes over what is
 * made), going on to the next chapter when the song has all of this one.
 * Null when nothing is left from there on.
 */
function startChapter(
  definition: LessonDefinition,
  chapterIndex: number,
  from: number,
  world: LessonWorld,
  settings: LessonSettings,
  endings: LessonState["endings"],
  passedBefore: readonly BiteId[] = [],
  keep: BiteId | null = null,
  carried: readonly BiteId[] = [],
): LessonTransition | null {
  const lessonChapter = definition.chapters[chapterIndex];
  if (!lessonChapter) return null;
  const made = definition.passesOverMade
    ? madeBites(lessonChapter.id, world, settings).filter((id) => id !== keep)
    : [];
  const skips = new Set(made);
  const index = lessonChapter.bites.findIndex(
    (one, at) => at >= from && !skips.has(one.id),
  );
  // Only what the song has from `from` on is told as passed over.
  const madeFrom = (to?: number) =>
    lessonChapter.bites
      .slice(from, to)
      .map((one) => one.id)
      .filter((id) => skips.has(id));
  if (index < 0) {
    return startChapter(
      definition,
      chapterIndex + 1,
      0,
      world,
      settings,
      endings,
      [...passedBefore, ...madeFrom()],
      null,
      [...carried, ...made],
    );
  }
  // What earlier chapters passed over stays passed over, for the strip.
  const passed = [...carried, ...made];
  return startAt(
    { lessonId: definition.id, chapterIndex, biteIndex: index, endings, passed },
    world,
    settings,
    [...passedBefore, ...madeFrom(index)],
  );
}

/** The record's endings, of the bites this build knows. */
function knownEndings(
  endings: Readonly<Record<string, string>>,
): Partial<Record<BiteId, BiteEnding>> {
  const known: Partial<Record<BiteId, BiteEnding>> = {};
  for (const [id, how] of Object.entries(endings)) {
    if (isBiteId(id) && (BITE_ENDINGS as readonly string[]).includes(how)) {
      known[id] = how as BiteEnding;
    }
  }
  return known;
}

/**
 * The lesson as the record left it under way, against the world as it is
 * now: the bite at the step it was on, or, when that bite was over, waiting
 * for the producer to pull the next. Null when the record names a place the
 * lesson does not have.
 */
function resumeAt(
  definition: LessonDefinition,
  underWay: NonNullable<LessonRecord["underWay"]>,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition | null {
  const lessonChapter = definition.chapters[underWay.chapterIndex];
  const biteIndex =
    lessonChapter?.bites.findIndex((one) => one.id === underWay.biteId) ?? -1;
  if (!lessonChapter || biteIndex < 0) return null;
  const lessonBite = lessonChapter.bites[biteIndex];
  const endings = knownEndings(underWay.endings);
  const passed = underWay.passed.filter(isBiteId);
  const over = endings[lessonBite.id] !== undefined;
  const step = over
    ? null
    : (stepAt(lessonBite, world, settings, underWay.stepIndex - 1) ??
      stepAt(lessonBite, world, settings, -1));
  const state: LessonState = {
    lessonId: definition.id,
    chapterIndex: underWay.chapterIndex,
    biteIndex,
    step,
    biteStart: world,
    stepEndings: [],
    endings,
    passed,
  };
  if (over && lessonFinished(state)) return null;
  return { state, event: { kind: "bite_started", passed: [] } };
}

/** Where in `definition` bite `biteId` is, or null when it is not one of its. */
function placeOf(
  definition: LessonDefinition,
  biteId: BiteId,
): { readonly chapterIndex: number; readonly biteIndex: number } | null {
  for (const [chapterIndex, each] of definition.chapters.entries()) {
    const biteIndex = each.bites.findIndex((one) => one.id === biteId);
    if (biteIndex >= 0) return { chapterIndex, biteIndex };
  }
  return null;
}

/**
 * Starts lesson `lessonId` (GRV-190), the one way a lesson starts. The
 * position comes from `record`: where the lesson was under way, at the same
 * bite and step; or, when it is not under way there, its first chapter from
 * the first bite, passing over what this song already has in a lesson that
 * builds on it. `at` starts at that bite instead. Nothing is ever inferred
 * from the bites the record has as finished, so a finished lesson starts
 * again from its first bite. Null when there is nothing left to teach.
 */
export function startLesson(
  lessonId: LessonId,
  record: Pick<LessonRecord, "underWay"> | null,
  world: LessonWorld,
  settings: LessonSettings,
  at?: BiteId,
): LessonTransition | null {
  const definition = lesson(lessonId);
  const place = at ? placeOf(definition, at) : null;
  if (place && at) {
    return startChapter(
      definition,
      place.chapterIndex,
      place.biteIndex,
      world,
      settings,
      {},
      [],
      at,
    );
  }
  const underWay = record?.underWay;
  if (underWay?.lessonId === lessonId) {
    const resumed = resumeAt(definition, underWay, world, settings);
    if (resumed) return resumed;
  }
  return startChapter(definition, 0, 0, world, settings, {});
}

/**
 * The next bite, once the one before is over: the chapter's next not passed
 * over, or the lesson's next chapter, from its first bite the song does not
 * have. Null when there is none.
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
      { ...state, biteIndex: index },
      world,
      settings,
      bites
        .slice(state.biteIndex + 1, index)
        .map((one) => one.id)
        .filter((id) => state.passed.includes(id)),
    );
  }
  return startChapter(
    lessonOf(state),
    state.chapterIndex + 1,
    0,
    world,
    settings,
    state.endings,
    [],
    null,
    state.passed,
  );
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
      lessonDone: lessonFinished(ended),
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
