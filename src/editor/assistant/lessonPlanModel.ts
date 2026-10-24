/**
 * What the lesson's plan and the Lessons list show (GRV-190), worked out from
 * the lesson under way and the project's record, so the components only draw
 * it. Pure.
 *
 * A bite is one tick: white once done (by the producer or by Show me),
 * hatched when skipped, dim grey when the song already had it, outlined for
 * the one under way, and plain grey still to come. Only this time through
 * counts on the plan: a lesson started again starts with nothing done.
 */
import type { BiteEnding, BiteId } from "../../lessons/ids";
import { chapterOf, type LessonState, lessonOf } from "../../lessons/session";
import type { LessonBite, LessonDefinition } from "../../lessons/types";

/** How one bite stands, as its tick draws it. */
export type Tick = "done" | "skipped" | "passed" | "current" | "todo";

/** How a chapter of the lesson under way stands, as its column of the strip says. */
export type ChapterStanding = "done" | "current" | "next";

/** The plan's first line on a lesson's first bite: what a lesson is, for the whole of it. */
export const LESSON_INTRO =
  "Coproducer teaches this one step at a time in your project. Do each step yourself, or press Show me. Leave at any time.";

/** The words a finished or passed bite's chip says. */
export const STATUS_WORDS: Readonly<Record<"done" | "skipped" | "passed", string>> = {
  done: "done",
  skipped: "skipped",
  passed: "already in your song",
};

function endingTick(how: BiteEnding): Tick {
  return how === "skipped" ? "skipped" : "done";
}

/** How bite `bite` stands in the lesson under way, this time through. */
export function planTick(state: LessonState, bite: LessonBite): Tick {
  const ending = state.endings[bite.id];
  if (ending) return endingTick(ending);
  if (state.passed.includes(bite.id)) return "passed";
  return bite.id === chapterOf(state).bites[state.biteIndex]?.id ? "current" : "todo";
}

/** How chapter `index` of the lesson under way stands. */
export function chapterStanding(state: LessonState, index: number): ChapterStanding {
  if (index < state.chapterIndex) return "done";
  return index === state.chapterIndex ? "current" : "next";
}

/** The plan's place: the bite's, and that it is done while it waits on Next. */
export function planPlace(state: LessonState): string {
  const over = state.step === null ? " · done" : "";
  return `bite ${state.biteIndex + 1} of ${chapterOf(state).bites.length}${over}`;
}

/** The plan's eyebrow: that this is a lesson, and which. */
export function planEyebrow(state: LessonState): string {
  return `Lesson · ${lessonOf(state).title}`;
}

/** Whether the plan's first line shows: nothing is over yet this time through. */
export function showsIntro(state: LessonState): boolean {
  return Object.keys(state.endings).length === 0;
}

/** A row of the Lessons list. */
export interface LessonProgress {
  /** "Not started", "2 of 5 done", "Done", or "In progress" for the one under way. */
  readonly text: string;
  readonly underWay: boolean;
  /** One per bite, chapter by chapter. */
  readonly ticks: readonly Tick[];
}

/**
 * How `lesson` stands, for its row: the one under way by where it is this
 * time through; any other by this project's record, and "Done" once every
 * bite is done here or, by the profile, in any project.
 */
export function lessonProgress(
  lesson: LessonDefinition,
  finished: Readonly<Partial<Record<BiteId, BiteEnding>>>,
  doneAnywhere: readonly string[],
  state: LessonState | null,
): LessonProgress {
  const bites = lesson.chapters.flatMap((one) => one.bites);
  if (state && state.lessonId === lesson.id) {
    return {
      text: "In progress",
      underWay: true,
      ticks: bites.map((bite) => planTick(state, bite)),
    };
  }
  const ticks = bites.map((bite): Tick => {
    const how = finished[bite.id];
    return how ? endingTick(how) : "todo";
  });
  const doneHere = ticks.filter((tick) => tick === "done").length;
  const anywhere = new Set(doneAnywhere);
  const allDone = bites.every(
    (bite, at) => anywhere.has(bite.id) || ticks[at] === "done",
  );
  const text = allDone
    ? "Done"
    : doneHere === 0
      ? "Not started"
      : `${doneHere} of ${bites.length} done`;
  return { text, underWay: false, ticks };
}
