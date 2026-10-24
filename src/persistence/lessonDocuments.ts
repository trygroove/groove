import { z } from "zod";
import type { JsonObject } from "../domain/serialize";
import { LESSON_BITE_ID_PATTERN, MAX_LESSON_BITE_ID_CHARS } from "./profileDocuments";

/**
 * The Firestore layout of a producer's lesson record (GRV-190): where every
 * lesson stands in one project, so a reload, another tab or another device
 * brings the lesson back at the same step.
 *
 * | Path                              | Contents                              |
 * | --------------------------------- | ------------------------------------- |
 * | `users/{uid}/lessons/{projectId}` | Every lesson's progress in a project |
 *
 * It belongs to the producer, like the profile, so it lives under the user
 * and not in the project: a collaborator on the same project has a lesson of
 * their own. `firestore.rules` restricts it to its owner and checks its shape.
 *
 * - **`underWay`** is the lesson under way, or null when none is (one ended,
 *   or was left): which lesson, which of its chapters, the bite and the step,
 *   how the lesson's bites have ended this time through, and the bites its
 *   chapter passed over because the song already had them.
 * - **`finished`** is every bite finished in this project, and how: done,
 *   shown by Show me, or skipped. Nothing reads a position from it; it is
 *   what the Lessons list shows as progress.
 *
 * IDs are ours (`src/lessons/ids.ts`), never the producer's words, and are
 * checked by their shape rather than against today's list, so a build that
 * does not know a newer bite still reads the record (and the lessons layer
 * drops what it does not know). Every time is integer epoch milliseconds.
 */

/** The version every lesson record is written at. */
export const LESSON_RECORD_VERSION = 1;

export const LESSONS_COLLECTION = "lessons";

/** The most bites one record keeps as finished; there are far fewer bites. */
export const MAX_FINISHED_BITES = 100;
/** The most bites one record keeps endings or passed-over bites for. */
export const MAX_UNDER_WAY_BITES = 50;

/** How a bite ended, as the record keeps it. */
export const RECORD_BITE_ENDINGS = ["did_it", "show_me", "skipped"] as const;
export type RecordBiteEnding = (typeof RECORD_BITE_ENDINGS)[number];

/** `users/{uid}/lessons`. */
export function lessonsCollectionPath(uid: string): string {
  return `users/${uid}/${LESSONS_COLLECTION}`;
}

/** `users/{uid}/lessons/{projectId}`. */
export function lessonRecordPath(uid: string, projectId: string): string {
  return `${lessonsCollectionPath(uid)}/${projectId}`;
}

const id = z.string().min(1).max(MAX_LESSON_BITE_ID_CHARS).regex(LESSON_BITE_ID_PATTERN);
const time = z.number().int().nonnegative();
const index = z.number().int().min(0).max(100);
const ending = z.enum(RECORD_BITE_ENDINGS);

/** The lesson under way, as the record keeps it. */
export const lessonUnderWaySchema = z.strictObject({
  lessonId: id,
  chapterIndex: index,
  biteId: id,
  /** The step under way, or the bite's step count once the bite is over. */
  stepIndex: index,
  endings: z
    .record(id, ending)
    .refine((value) => Object.keys(value).length <= MAX_UNDER_WAY_BITES),
  passed: z.array(id).max(MAX_UNDER_WAY_BITES),
});
export type LessonUnderWay = z.infer<typeof lessonUnderWaySchema>;

export const finishedBiteSchema = z.strictObject({ how: ending, at: time });
export type FinishedBite = z.infer<typeof finishedBiteSchema>;

/** A record's fields, as a caller hands one over to be saved. */
export const lessonRecordSchema = z.strictObject({
  underWay: lessonUnderWaySchema.nullable(),
  finished: z
    .record(id, finishedBiteSchema)
    .refine((value) => Object.keys(value).length <= MAX_FINISHED_BITES),
  updatedAt: time,
});
export type LessonRecord = z.infer<typeof lessonRecordSchema>;

const lessonRecordDocumentSchema = lessonRecordSchema.extend({
  version: z.literal(LESSON_RECORD_VERSION),
});

/** The record of a project no lesson has been taken in. */
export function emptyLessonRecord(now = 0): LessonRecord {
  return { underWay: null, finished: {}, updatedAt: now };
}

/** The stored body of a record. */
export function encodeLessonRecord(record: LessonRecord): JsonObject {
  const finished: JsonObject = {};
  for (const [biteId, entry] of Object.entries(record.finished)) {
    finished[biteId] = { how: entry.how, at: entry.at };
  }
  const underWay = record.underWay;
  return {
    version: LESSON_RECORD_VERSION,
    underWay: underWay
      ? {
          lessonId: underWay.lessonId,
          chapterIndex: underWay.chapterIndex,
          biteId: underWay.biteId,
          stepIndex: underWay.stepIndex,
          endings: { ...underWay.endings },
          passed: [...underWay.passed],
        }
      : null,
    finished,
    updatedAt: record.updatedAt,
  };
}

/**
 * Reads a stored record, or `null` when the document is not one this build
 * understands. Never repairs: a record that does not parse is refused whole.
 */
export function decodeLessonRecord(data: unknown): LessonRecord | null {
  const parsed = lessonRecordDocumentSchema.safeParse(data);
  if (!parsed.success) return null;
  const { version: _version, ...record } = parsed.data;
  return record;
}
