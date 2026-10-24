/**
 * Every chapter (GRV-43, GRV-44) and every lesson (GRV-190), and what the
 * rest of the app asks of them: a bite by ID, a lesson by ID, the chapter a
 * producer's goal suggests, the next bite they have not been through, and
 * the steps of a bite that apply to their project.
 */
import type { ProducerGoal } from "../persistence/profileDocuments";
import { ARRANGE_CHAPTER } from "./arrange";
import { BASS_CHAPTER } from "./bass";
import { BEAT_CHAPTER } from "./beat";
import { CHORDS_CHAPTER } from "./chords";
import {
  type BiteId,
  type ChapterId,
  type LessonId,
  SOLO_CHAPTER_IDS,
  type SoloChapterId,
  TRACK_CHAPTER_IDS,
} from "./ids";
import { MIX_CHAPTER } from "./mix";
import { SOUND_CHAPTER } from "./sound";
import { TOUR_CHAPTER } from "./tour";
import type {
  LessonBite,
  LessonChapter,
  LessonDefinition,
  LessonSettings,
  LessonStep,
  LessonWorld,
} from "./types";

/** Every chapter, in `CHAPTER_IDS`' order: the three taught alone, then "Finish a track"'s own. */
export const CHAPTERS: readonly LessonChapter[] = [
  BEAT_CHAPTER,
  SOUND_CHAPTER,
  TOUR_CHAPTER,
  BASS_CHAPTER,
  CHORDS_CHAPTER,
  ARRANGE_CHAPTER,
  MIX_CHAPTER,
];

export function chapter(id: ChapterId): LessonChapter {
  const found = CHAPTERS.find((candidate) => candidate.id === id);
  if (!found) throw new TypeError(`No chapter "${id}"`);
  return found;
}

export function bite(id: BiteId): LessonBite {
  for (const candidate of CHAPTERS) {
    const found = candidate.bites.find((one) => one.id === id);
    if (found) return found;
  }
  throw new TypeError(`No bite "${id}"`);
}

/** A chapter taught alone, as a lesson of one. */
function soloLesson(id: SoloChapterId): LessonDefinition {
  const one = chapter(id);
  return {
    id,
    title: one.title,
    summary: one.summary,
    chapters: [one],
    passesOverMade: false,
  };
}

/** "Finish a track" (GRV-44): the long lesson, from a beat to stems. */
export const TRACK_LESSON: LessonDefinition = {
  id: "track",
  title: "Finish a track",
  summary: "a beat, a bass, chords and a hook, arranged, mixed and exported as stems",
  chapters: TRACK_CHAPTER_IDS.map(chapter),
  passesOverMade: true,
};

/**
 * Every lesson, in the order the Lessons list shows them (GRV-190): the tour
 * first, then the beat and the sound, then "Finish a track".
 */
export const LESSONS: readonly LessonDefinition[] = [
  soloLesson("tour"),
  soloLesson("beat"),
  soloLesson("sound"),
  TRACK_LESSON,
];

export function lesson(id: LessonId): LessonDefinition {
  const found = LESSONS.find((candidate) => candidate.id === id);
  if (!found) throw new TypeError(`No lesson "${id}"`);
  return found;
}

/**
 * The lesson onboarding suggests (GRV-190): the tour, for every goal, so a
 * new producer knows their way round before making anything.
 */
export function chapterForGoal(_goal: ProducerGoal | null): SoloChapterId {
  return "tour";
}

/**
 * The lesson a goal from onboarding points at once the tour is done
 * (GRV-190): "Make a beat" for a first track, a video or a game, or anyone
 * just curious; "Shape a sound" for sound design.
 */
export function lessonForGoal(goal: ProducerGoal | null): SoloChapterId {
  return goal === "sound_design" ? "sound" : "beat";
}

/**
 * The first bite not yet in `done` of the chapters taught on their own: in
 * `from`'s chapter first, then in the chapters after it, then those before.
 * Null once every one of their bites is done.
 */
export function nextBite(
  done: readonly string[],
  from: SoloChapterId = SOLO_CHAPTER_IDS[0],
): LessonBite | null {
  const finished = new Set(done);
  const start = SOLO_CHAPTER_IDS.indexOf(from);
  const order = [...SOLO_CHAPTER_IDS.slice(start), ...SOLO_CHAPTER_IDS.slice(0, start)];
  for (const id of order) {
    const found = chapter(id).bites.find((one) => !finished.has(one.id));
    if (found) return found;
  }
  return null;
}

/**
 * The step of `bite` to take after step `after` (or the first, without one):
 * the next whose `applies` holds in `world`. Null when the bite has no step
 * left.
 */
export function nextStep(
  lessonBite: LessonBite,
  world: LessonWorld,
  settings: LessonSettings,
  after = -1,
): { readonly index: number; readonly step: LessonStep } | null {
  for (let index = after + 1; index < lessonBite.steps.length; index += 1) {
    const step = lessonBite.steps[index];
    if (step.applies?.(world, settings) ?? true) return { index, step };
  }
  return null;
}

/** Every bite, chapter by chapter: the order `BITE_IDS` lists them in. */
export const ALL_BITES: readonly LessonBite[] = CHAPTERS.flatMap((one) => one.bites);
