/**
 * Cue's one nudge a day (GRV-25): when it may offer a returning producer
 * something to try, and what. Pure, so the rule is tested on its own.
 *
 * Nothing else is pushed in the app: the producer pulls what they need from
 * Cue. Email nudges are GRV-45, streaks and challenges GRV-46.
 */
import { suggestedLesson } from "../onboarding/questions";
import type { ProducerProfile } from "../persistence/profileDocuments";

/** The local calendar day of `ms`, as `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether Cue may nudge `profile` at `now`: they have been through onboarding
 * (completed or skipped) on an earlier day, and have not been nudged today.
 */
export function nudgeDue(profile: ProducerProfile | null, now: number): boolean {
  if (!profile?.onboarding || profile.onboardedAt === null) return false;
  const today = localDay(now);
  return localDay(profile.onboardedAt) < today && profile.lastNudgeDay !== today;
}

/**
 * What Cue offers: the next unfinished bite once lessons exist (GRV-43); for
 * now the first lesson its goal suggests.
 */
export function nudgeLesson(profile: ProducerProfile): string {
  return suggestedLesson(profile.memory.goal);
}
