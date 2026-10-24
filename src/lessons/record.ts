/**
 * A project's lesson record as the lessons read and write it (GRV-190): the
 * lesson under way, kept on every transition, and the bites finished. Pure,
 * over the record's stored shape (`src/persistence/lessonDocuments.ts`), so
 * a reload, another tab and another device all read the same place.
 *
 * Nothing here reads a position out of the bites finished: `startLesson`
 * reads `underWay` alone. The profile's flat `lessonsDone` is derived from
 * the finished bites ({@link withLessonsDone}), never the other way round.
 */
import type { LessonRecord, LessonUnderWay } from "../persistence/lessonDocuments";
import { type BiteEnding, type BiteId, isBiteId } from "./ids";
import { biteOf, type LessonState } from "./session";

/** Where `state` stands, as the record keeps it. */
export function underWayOf(state: LessonState): LessonUnderWay {
  return {
    lessonId: state.lessonId,
    chapterIndex: state.chapterIndex,
    biteId: biteOf(state).id,
    // A bite over is kept past its last step: it waits on Next.
    stepIndex: state.step?.index ?? biteOf(state).steps.length,
    endings: { ...state.endings },
    passed: [...state.passed],
  };
}

/**
 * `record` with the lesson now under way (`null` once it ended or was left)
 * and, when a bite just finished, that bite as `how`, at `now`.
 */
export function recordWith(
  record: LessonRecord,
  state: LessonState | null,
  now: number,
  finished?: { readonly biteId: BiteId; readonly how: BiteEnding },
): LessonRecord {
  return {
    underWay: state ? underWayOf(state) : null,
    finished: finished
      ? { ...record.finished, [finished.biteId]: { how: finished.how, at: now } }
      : record.finished,
    updatedAt: now,
  };
}

/** How each bite this build knows ended in the record, skipped ones included. */
export function finishedBites(
  record: Pick<LessonRecord, "finished"> | null,
): Partial<Record<BiteId, BiteEnding>> {
  const found: Partial<Record<BiteId, BiteEnding>> = {};
  for (const [id, entry] of Object.entries(record?.finished ?? {})) {
    if (isBiteId(id)) found[id] = entry.how;
  }
  return found;
}

/** The bites the record has as done (by the producer or by Show me), never skipped. */
export function doneBites(record: Pick<LessonRecord, "finished"> | null): BiteId[] {
  return Object.entries(finishedBites(record))
    .filter(([, how]) => how !== "skipped")
    .map(([id]) => id as BiteId);
}

/**
 * The profile's `lessonsDone`, derived (GRV-190): what it held, of the bites
 * this build knows, with every bite `record` has as done. Skipped bites are
 * never done.
 */
export function withLessonsDone(
  lessonsDone: readonly string[],
  record: Pick<LessonRecord, "finished">,
): string[] {
  const done = new Set(lessonsDone.filter(isBiteId));
  for (const id of doneBites(record)) done.add(id);
  return [...done];
}
