/**
 * Coproducer's one nudge a day (GRV-25): when it may offer a returning producer
 * something to try, and what. Pure, so the rule is tested on its own.
 *
 * Nothing else is pushed in the app: the producer pulls what they need from
 * Coproducer. Email nudges are GRV-45, streaks and challenges GRV-46.
 */
import { bite, chapter, chapterForGoal, nextBite } from "../lessons/chapters";
import { isTrackChapterId } from "../lessons/ids";
import { TRACK_TITLE, trackChapterNumber, trackResume } from "../lessons/track";
import type { LessonBite } from "../lessons/types";
import type { ProducerProfile } from "../persistence/profileDocuments";

/** The local calendar day of `ms`, as `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether Coproducer may nudge `profile` at `now`: they have been through onboarding
 * (completed or skipped) on an earlier day, and have not been nudged today.
 */
export function nudgeDue(profile: ProducerProfile | null, now: number): boolean {
  if (!profile?.onboarding || profile.onboardedAt === null) return false;
  const today = localDay(now);
  return localDay(profile.onboardedAt) < today && profile.lastNudgeDay !== today;
}

/**
 * What Coproducer offers (GRV-43): "Finish a track" where they left it, while
 * it is under way (GRV-44); otherwise the next lesson bite they have not been
 * through, starting in the chapter their goal suggests. Null once they have
 * been through every bite: there is nothing left to offer.
 */
export function nudgeBite(profile: ProducerProfile): LessonBite | null {
  const resume = trackResume(profile.lessonsDone);
  if (resume) return bite(resume.biteId);
  return nextBite(profile.lessonsDone, chapterForGoal(profile.memory.goal));
}

/**
 * What the nudge says of `offered`: "Want to try" a bite, or, when it is where
 * "Finish a track" picks up by what `done` records (GRV-44), which chapter of
 * it to pick up, its first, "Make a beat", included.
 */
export function nudgeWords(offered: LessonBite, done: readonly string[]): string {
  const resume = trackResume(done);
  if (resume?.biteId === offered.id && isTrackChapterId(offered.chapter)) {
    const number = trackChapterNumber(offered.chapter);
    return `Pick up chapter ${number} of "${TRACK_TITLE}", "${chapter(offered.chapter).title}"?`;
  }
  return `Want to try "${offered.title}"?`;
}
