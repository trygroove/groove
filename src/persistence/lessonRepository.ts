import type { LessonRecord } from "./lessonDocuments";

/**
 * The lesson record boundary (GRV-190): where every lesson stands in one of
 * a producer's projects, kept per user and project so a lesson comes back at
 * the same step after a reload, in another tab and on another device.
 *
 * It mirrors `ProfileRepository`: one interface, an in-memory store for unit,
 * component and browser tests, and a Firestore store for production, both run
 * through one contract suite (`lessonRepositoryContract.ts`). Only the
 * Firestore implementation imports `firebase/firestore`.
 *
 * A record is one small document, read whole and written whole. A save stamps
 * `updatedAt` and returns the record as stored.
 */

export type LessonRecordFailureReason =
  /** The record handed over is not a valid one. */
  | "invalid_record"
  /** The stored record is not one this build can read. */
  | "unreadable"
  /** The caller may not read or write this user's records. */
  | "not_allowed"
  /** The backend could not be reached or failed transiently. */
  | "unavailable";

export interface LessonRecordFailure {
  readonly ok: false;
  readonly reason: LessonRecordFailureReason;
  readonly message: string;
  /** Whether retrying the identical call could succeed. */
  readonly retryable: boolean;
}

export type LessonRecordLoadResult =
  /** `record` is `null` for a project no lesson has been taken in. */
  { readonly ok: true; readonly record: LessonRecord | null } | LessonRecordFailure;

export type LessonRecordSaveResult =
  | { readonly ok: true; readonly record: LessonRecord }
  | LessonRecordFailure;

export interface LessonRepository {
  /** The user's record for the project, or `null` when there is none yet. */
  loadRecord(uid: string, projectId: string): Promise<LessonRecordLoadResult>;
  /** Writes the user's whole record for the project, stamped with when. */
  saveRecord(
    uid: string,
    projectId: string,
    record: LessonRecord,
  ): Promise<LessonRecordSaveResult>;
}

export function lessonRecordFailure(
  reason: LessonRecordFailureReason,
  message: string,
): LessonRecordFailure {
  return { ok: false, reason, message, retryable: reason === "unavailable" };
}
