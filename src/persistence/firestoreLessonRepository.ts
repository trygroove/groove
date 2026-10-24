import { doc, type Firestore, getDoc, setDoc } from "firebase/firestore";
import { type Clock, systemClock } from "../shared/clock";
import {
  decodeLessonRecord,
  encodeLessonRecord,
  type LessonRecord,
  lessonRecordPath,
  lessonRecordSchema,
} from "./lessonDocuments";
import {
  type LessonRecordFailure,
  type LessonRecordLoadResult,
  type LessonRecordSaveResult,
  type LessonRepository,
  lessonRecordFailure,
} from "./lessonRepository";

/**
 * The Firestore lesson record store (GRV-190): one document per project at
 * `users/{uid}/lessons/{projectId}`, read with one `getDoc` and written whole
 * with one `setDoc`, so an offline write is queued and applied when the
 * session reconnects.
 *
 * Like the other Firestore stores, the `Firestore` instance is injected, so
 * the emulator suite runs the identical code through the real security rules.
 */
export class FirestoreLessonRepository implements LessonRepository {
  private readonly db: Firestore;
  private readonly clock: Clock;

  constructor(db: Firestore, options: { clock?: Clock } = {}) {
    this.db = db;
    this.clock = options.clock ?? systemClock;
  }

  async loadRecord(uid: string, projectId: string): Promise<LessonRecordLoadResult> {
    try {
      const snapshot = await getDoc(doc(this.db, lessonRecordPath(uid, projectId)));
      if (!snapshot.exists()) return { ok: true, record: null };
      const record = decodeLessonRecord(snapshot.data());
      return record
        ? { ok: true, record }
        : lessonRecordFailure("unreadable", "The stored lesson record could not be read");
    } catch (error) {
      return toFailure(error);
    }
  }

  async saveRecord(
    uid: string,
    projectId: string,
    record: LessonRecord,
  ): Promise<LessonRecordSaveResult> {
    const parsed = lessonRecordSchema.safeParse({
      ...record,
      updatedAt: this.clock.now(),
    });
    if (!parsed.success) {
      return lessonRecordFailure("invalid_record", parsed.error.message);
    }
    try {
      await setDoc(
        doc(this.db, lessonRecordPath(uid, projectId)),
        encodeLessonRecord(parsed.data),
      );
      return { ok: true, record: parsed.data };
    } catch (error) {
      return toFailure(error);
    }
  }
}

function toFailure(error: unknown): LessonRecordFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "permission-denied") {
    return lessonRecordFailure(
      "not_allowed",
      "The current user may not access this lesson record",
    );
  }
  return lessonRecordFailure(
    "unavailable",
    error instanceof Error ? error.message : String(error),
  );
}
