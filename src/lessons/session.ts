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
 */

import { describeChanges } from "./changes";
import { chapter, nextStep } from "./chapters";
import { plainInstruction } from "./glossary";
import type { BiteEnding, BiteId, ChapterId } from "./ids";
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
}

/** What happened, for Coproducer and analytics. */
export type LessonEvent =
  | { readonly kind: "bite_started" }
  | { readonly kind: "step_done"; readonly how: BiteEnding; readonly changes: string[] }
  | {
      readonly kind: "bite_done";
      readonly how: BiteEnding;
      readonly changes: string[];
      /** Whether it was the chapter's last. */
      readonly chapterDone: boolean;
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

/** Whether the lesson's last bite is over: nothing is left to pull. */
export function chapterFinished(state: LessonState): boolean {
  return state.step === null && state.biteIndex >= chapterOf(state).bites.length - 1;
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
  const biteIndex = Math.max(0, found);
  return {
    state: {
      chapter: chapterId,
      biteIndex,
      step: stepAt(bites[biteIndex], world, settings, -1),
      biteStart: world,
      stepEndings: [],
      endings,
    },
    event: { kind: "bite_started" },
  };
}

/**
 * The lesson as it stood before a reload: bite `biteId` of `chapterId` with
 * how the chapter's bites had ended. A bite under way starts again from the
 * world as it is now; one that was over waits for the producer to pull the
 * next. Null when that bite was the chapter's last and is over: the lesson
 * had ended.
 */
export function resumeLesson(
  chapterId: ChapterId,
  biteId: BiteId,
  world: LessonWorld,
  settings: LessonSettings,
  endings: LessonState["endings"],
): LessonState | null {
  const { state } = startBite(chapterId, biteId, world, settings, endings);
  if (!endings[biteOf(state).id]) return state;
  const over: LessonState = { ...state, step: null };
  return chapterFinished(over) ? null : over;
}

/** The next bite, once the one before is over; null after the chapter's last. */
export function startNextBite(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition | null {
  if (state.step !== null) return null;
  const next = chapterOf(state).bites[state.biteIndex + 1];
  return next ? startBite(state.chapter, next.id, world, settings, state.endings) : null;
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
