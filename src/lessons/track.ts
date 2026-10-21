/**
 * "Finish a track" (GRV-44): the long lesson, in which the producer finishes
 * a track with Coproducer and leaves with stems. Its five chapters follow one
 * another (`TRACK_CHAPTER_IDS`): a beat, a bass, chords and a hook, the
 * arrangement, and the mix and export. Pure.
 *
 * - **Resumable.** Done bites are saved on the profile as every lesson's are,
 *   and so is {@link TRACK_UNDER_WAY} once the lesson starts, so it is under
 *   way from its first bite, "Make a beat" included, until its last bite is
 *   done; {@link trackResume} says where to pick it up.
 * - **What the song has is passed over.** As each chapter starts, a bite
 *   whose part the song already has (`LessonBite.made`) is passed over: the
 *   whole of "Make a beat" when the song has a beat, or just its kick when the
 *   kick is already in place.
 * - **What is done is passed over.** While it is under way, a bite of its own
 *   chapters already done ({@link trackProgress}) is passed over too, so it
 *   only ever goes forward from where the producer is.
 */
import { chapter } from "./chapters";
import {
  type BiteId,
  TRACK_CHAPTER_IDS,
  TRACK_UNDER_WAY,
  type TrackChapterId,
} from "./ids";
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
 * Where to pick the lesson up, by what `done` records. It is under way once it
 * has started ({@link TRACK_UNDER_WAY}) or a bite only it teaches is done, and
 * until the last of those is: a bite skipped is not saved as done, so the
 * lesson can end with some left. Once a chapter of its own is started it
 * picks up where the producer actually is, at the first bite not done after
 * the furthest one done: a bite skipped on the way is not offered again.
 * Before that it picks up at the first bite of "Make a beat" not done. Null
 * when it is not under way.
 */
export function trackResume(
  done: readonly string[],
): { readonly chapter: TrackChapterId; readonly biteId: BiteId } | null {
  const finished = new Set(done);
  const own = OWN_CHAPTERS.flatMap((one) => one.bites);
  const furthest = own.findLastIndex((one) => finished.has(one.id));
  if (furthest < 0 && !finished.has(TRACK_UNDER_WAY)) return null;
  const next =
    furthest < 0
      ? TRACK_CHAPTERS.flatMap((one) => one.bites).find((one) => !finished.has(one.id))
      : own[furthest + 1];
  return next ? { chapter: next.chapter as TrackChapterId, biteId: next.id } : null;
}

/**
 * What the lesson passes over as done by `done` as it goes on: everything
 * `done` records while it is under way ({@link trackResume}), so a producer
 * who goes back to a chapter is not taught again what they did after it;
 * nothing once it is over, so taking it again teaches it all.
 */
export function trackProgress(done: readonly string[]): readonly string[] {
  return trackResume(done) ? done : [];
}

/** `done` with "Finish a track" recorded as started, once. */
export function withTrackUnderWay(done: readonly string[]): string[] {
  return done.includes(TRACK_UNDER_WAY) ? [...done] : [...done, TRACK_UNDER_WAY];
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
