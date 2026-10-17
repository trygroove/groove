/**
 * The consented customer-validation event (GRV-25).
 *
 * A producer may tick a box (on the "saved to memory" card, and on the Memory
 * page) to share their answers' fixed choices so we can check who Groove is
 * for. Unticked, nothing is logged. Ticked, one `onboarding_validation`
 * carries the experience level and the goal, and one
 * `onboarding_validation_chip` each learn and gear chip they picked. Never
 * artists, a genre, anything typed, or a note.
 */
import type { Analytics } from "../analytics/analytics";
import type { ProducerProfile } from "../persistence/profileDocuments";
import { validationAnswers } from "./questions";

/** Logs the validation events for `profile`, if it consents. Returns whether it did. */
export function logValidation(
  analytics: Pick<Analytics, "log">,
  profile: Pick<ProducerProfile, "validationConsent" | "memory">,
): boolean {
  if (!profile.validationConsent) return false;
  const answers = validationAnswers(profile.memory);
  analytics.log("onboarding_validation", {
    experience: answers.experience,
    goal: answers.goal,
  });
  for (const chip of answers.learn) {
    analytics.log("onboarding_validation_chip", { group: "learn", chip });
  }
  for (const chip of answers.gear) {
    analytics.log("onboarding_validation_chip", { group: "gear", chip });
  }
  return true;
}
