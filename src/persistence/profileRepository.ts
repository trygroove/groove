import type { ProducerProfile } from "./profileDocuments";

/**
 * The profile boundary (GRV-25): one producer's onboarding state and what Cue
 * remembers about them, kept per user so it follows the person across
 * projects and devices.
 *
 * It mirrors `FavouritesRepository`: one interface, an in-memory store for
 * unit, component and browser tests, and a Firestore store for production,
 * both run through one contract suite (`profileRepositoryContract.ts`). Only
 * the Firestore implementation imports `firebase/firestore`.
 *
 * The profile is one small document, read whole and written whole. A save
 * stamps `modifiedAt` and returns the profile as stored.
 */

export type ProfileFailureReason =
  /** The profile handed over is not a valid one. */
  | "invalid_profile"
  /** The stored profile is not one this build can read. */
  | "unreadable"
  /** The caller may not read or write this user's profile. */
  | "not_allowed"
  /** The backend could not be reached or failed transiently. */
  | "unavailable";

export interface ProfileFailure {
  readonly ok: false;
  readonly reason: ProfileFailureReason;
  readonly message: string;
  /** Whether retrying the identical call could succeed. */
  readonly retryable: boolean;
}

export type ProfileLoadResult =
  /** `profile` is `null` for someone who has never had one written. */
  { readonly ok: true; readonly profile: ProducerProfile | null } | ProfileFailure;

export type ProfileSaveResult =
  | { readonly ok: true; readonly profile: ProducerProfile }
  | ProfileFailure;

export interface ProfileRepository {
  /** The user's profile, or `null` when they have none yet. */
  loadProfile(uid: string): Promise<ProfileLoadResult>;
  /** Writes the user's whole profile, stamped with the time it was written. */
  saveProfile(uid: string, profile: ProducerProfile): Promise<ProfileSaveResult>;
}

export function profileFailure(
  reason: ProfileFailureReason,
  message: string,
): ProfileFailure {
  return { ok: false, reason, message, retryable: reason === "unavailable" };
}
