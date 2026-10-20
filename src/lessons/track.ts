/**
 * "Finish a track" (GRV-44): the long lesson, in which the producer finishes
 * a track with Coproducer and leaves with stems. Its five chapters follow one
 * another (`TRACK_CHAPTER_IDS`): a beat, a bass, chords and a hook, the
 * arrangement, and the mix and export. Pure.
 *
 * - **Resumable.** Done bites are saved on the profile as every lesson's are,
 *   so once the producer has been through a bite of a chapter only this
 *   lesson teaches, and not all of them, the lesson is under way, and
 *   {@link trackResume} says where to pick it up.
 * - **What the song has is passed over.** As each chapter starts, a bite
 *   whose part the song already has (`LessonBite.made`) is passed over: the
 *   whole of "Make a beat" when the song has a beat, or just its kick when the
 *   kick is already in place.
 */
import { chapter } from "./chapters";
import { type BiteId, TRACK_CHAPTER_IDS, type TrackChapterId } from "./ids";
import type { LessonChapter, LessonSettings, LessonWorld } from "./types";

/** The lesson's name, as the panel and Coproducer say it. */
export const TRACK_TITLE = "Finish a track";
/** What it makes, in a few words. */
export const TRACK_SUMMARY =
  "a beat, a bass, chords and a hook, arranged, mixed and exported as stems";

/** The lesson's chapters, in order. */
export const TRACK_CHAPTERS: readonly LessonChapter[] = TRACK_CHAPTER_IDS.map(chapter);

/** A chapter's place in the lesson, from 1. */
export function trackChapterNumber(id: TrackChapterId): number {
  return TRACK_CHAPTER_IDS.indexOf(id) + 1;
}

/** The chapter after `id`, or null after the last. */
export function nextTrackChapter(id: TrackChapterId): TrackChapterId | null {
  return TRACK_CHAPTER_IDS[TRACK_CHAPTER_IDS.indexOf(id) + 1] ?? null;
}

/** The chapters only this lesson teaches: every one but "Make a beat". */
const OWN_CHAPTERS = TRACK_CHAPTERS.slice(1);

/**
 * Where to pick the lesson up, by what `done` records: the first bite not
 * done of the first of its own chapters with one. Null when it is not under
 * way: none of its own bites done yet, or every one of them.
 */
export function trackResume(
  done: readonly string[],
): { readonly chapter: TrackChapterId; readonly biteId: BiteId } | null {
  const finished = new Set(done);
  const own = OWN_CHAPTERS.flatMap((one) => one.bites);
  if (!own.some((one) => finished.has(one.id))) return null;
  const next = own.find((one) => !finished.has(one.id));
  return next ? { chapter: next.chapter as TrackChapterId, biteId: next.id } : null;
}

/** The bites of `id` the song already has, as the chapter starts in `world`. */
export function madeBites(
  id: TrackChapterId,
  world: LessonWorld,
  settings: LessonSettings,
): BiteId[] {
  return chapter(id)
    .bites.filter((one) => one.made?.(world, settings) ?? false)
    .map((one) => one.id);
}
