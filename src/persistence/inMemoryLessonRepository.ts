import type { JsonObject } from "../domain/serialize";
import { type Clock, systemClock } from "../shared/clock";
import type { WriteRecord } from "./inMemoryProjectRepository";
import {
  decodeLessonRecord,
  encodeLessonRecord,
  type LessonRecord,
  lessonRecordPath,
  lessonRecordSchema,
} from "./lessonDocuments";
import {
  type LessonRecordLoadResult,
  type LessonRecordSaveResult,
  type LessonRepository,
  lessonRecordFailure,
} from "./lessonRepository";

/**
 * The in-memory lesson record store (GRV-190): the encoded documents at
 * their real paths, run through the same encode/decode as the Firestore
 * store, so the shared contract suite exercises the actual mapping. Like the
 * other in-memory stores it has no notion of identity; the rules that keep
 * one user out of another's records are proved in the emulator suite.
 */
export class InMemoryLessonRepository implements LessonRepository {
  private readonly documents = new Map<string, JsonObject>();
  private readonly writeLog: WriteRecord[] = [];
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  get writes(): readonly WriteRecord[] {
    return this.writeLog;
  }

  /** Writes a stored document verbatim, bypassing validation (test seeding). */
  writeDocument(path: string, data: JsonObject): void {
    this.documents.set(path, structuredClone(data));
  }

  async loadRecord(uid: string, projectId: string): Promise<LessonRecordLoadResult> {
    const stored = this.documents.get(lessonRecordPath(uid, projectId));
    if (!stored) return { ok: true, record: null };
    const record = decodeLessonRecord(structuredClone(stored));
    return record
      ? { ok: true, record }
      : lessonRecordFailure("unreadable", "The stored lesson record could not be read");
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
    const path = lessonRecordPath(uid, projectId);
    this.documents.set(path, encodeLessonRecord(parsed.data));
    this.writeLog.push({ kind: "set", path });
    return { ok: true, record: parsed.data };
  }
}

export function createInMemoryLessonRepository(
  options: { clock?: Clock } = {},
): InMemoryLessonRepository {
  return new InMemoryLessonRepository(options);
}
