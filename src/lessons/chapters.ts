/**
 * Every chapter (GRV-43, GRV-44), and what the rest of the app asks of them:
 * a bite by ID, the chapter a producer's goal suggests, the next bite they
 * have not been through, and the steps of a bite that apply to their project.
 */
import type { ProducerGoal } from "../persistence/profileDocuments";
import { ARRANGE_CHAPTER } from "./arrange";
import { BASS_CHAPTER } from "./bass";
import { BEAT_CHAPTER } from "./beat";
import { CHORDS_CHAPTER } from "./chords";
import { type BiteId, type ChapterId, SOLO_CHAPTER_IDS, type SoloChapterId } from "./ids";
import { MIX_CHAPTER } from "./mix";
import { SOUND_CHAPTER } from "./sound";
import { TOUR_CHAPTER } from "./tour";
import type {
  LessonBite,
  LessonChapter,
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

/** The chapter a goal from onboarding suggests starting with. */
export function chapterForGoal(goal: ProducerGoal | null): SoloChapterId {
  switch (goal) {
    case "first_track":
    case "video_or_game":
      return "beat";
    case "sound_design":
      return "sound";
    default:
      return "tour";
  }
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

/** `done` with `biteId` recorded, once, as the latest. */
export function withBiteDone(done: readonly string[], biteId: BiteId): string[] {
  return [...done.filter((id) => id !== biteId), biteId];
}

/** The bites of `chapterId` that `done` records, in the chapter's order. */
export function bitesDoneIn(chapterId: ChapterId, done: readonly string[]): BiteId[] {
  const finished = new Set(done);
  return chapter(chapterId)
    .bites.map((one) => one.id)
    .filter((id) => finished.has(id));
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
