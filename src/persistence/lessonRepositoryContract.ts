import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../domain/serialize";
import type { ManualClock } from "../shared/clock";
import {
  emptyLessonRecord,
  type LessonRecord,
  lessonRecordPath,
} from "./lessonDocuments";
import type { LessonRepository } from "./lessonRepository";

/**
 * The lesson record contract suite (GRV-190).
 *
 * The in-memory and Firestore stores both run it, so a component test that
 * saves a record through the fake is evidence about the real backend.
 * Anything specific to one store (its write log, the security rules) lives in
 * that store's own suite.
 */

export const LESSON_OWNER = "user_lessons";
export const LESSON_OTHER_OWNER = "user_other_lessons";
export const LESSON_PROJECT = "prj_lessons";
export const LESSON_OTHER_PROJECT = "prj_other_lessons";

/** A record with a lesson under way and a few bites finished. */
export function filledLessonRecord(now: number): LessonRecord {
  return {
    underWay: {
      lessonId: "track",
      chapterIndex: 1,
      biteId: "bass-line",
      stepIndex: 1,
      endings: { "bass-key": "did_it" },
      passed: ["bass-sound"],
    },
    finished: {
      "beat-kick": { how: "show_me", at: now },
      "beat-snare": { how: "skipped", at: now },
      "bass-key": { how: "did_it", at: now },
    },
    updatedAt: now,
  };
}

export interface LessonContractHarness {
  /** A repository acting as `uid`, as a separately signed-in session. */
  repositoryFor(uid: string): LessonRepository;
  readonly clock: ManualClock;
  reset(): Promise<void>;
  /** Writes a document verbatim, bypassing the repository and the rules. */
  seedStoredDocument(path: string, data: JsonObject): Promise<void>;
}

export function describeLessonRepositoryContract(
  label: string,
  createHarness: () => Promise<LessonContractHarness> | LessonContractHarness,
): void {
  describe(`${label}: LessonRepository contract`, () => {
    let harness: LessonContractHarness;
    let repository: LessonRepository;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
      harness.clock.set(1_700_000_000_000);
      repository = harness.repositoryFor(LESSON_OWNER);
    });

    it("has no record for a project no lesson was taken in", async () => {
      expect(await repository.loadRecord(LESSON_OWNER, LESSON_PROJECT)).toEqual({
        ok: true,
        record: null,
      });
    });

    it("round-trips every field, stamping when it was written", async () => {
      const record = filledLessonRecord(1_600_000_000_000);
      const saved = await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, record);
      const stamped = { ...record, updatedAt: 1_700_000_000_000 };
      expect(saved).toEqual({ ok: true, record: stamped });
      expect(
        await harness
          .repositoryFor(LESSON_OWNER)
          .loadRecord(LESSON_OWNER, LESSON_PROJECT),
      ).toEqual({ ok: true, record: stamped });
    });

    it("round-trips a record with no lesson under way", async () => {
      await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, emptyLessonRecord(0));
      expect(await repository.loadRecord(LESSON_OWNER, LESSON_PROJECT)).toEqual({
        ok: true,
        record: emptyLessonRecord(1_700_000_000_000),
      });
    });

    it("replaces the whole record on a save", async () => {
      await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, filledLessonRecord(1));
      await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, {
        ...filledLessonRecord(1),
        underWay: null,
        finished: { "tour-mixer": { how: "did_it", at: 2 } },
      });
      const loaded = await repository.loadRecord(LESSON_OWNER, LESSON_PROJECT);
      expect(loaded.ok && loaded.record?.underWay).toBeNull();
      expect(loaded.ok && loaded.record?.finished).toEqual({
        "tour-mixer": { how: "did_it", at: 2 },
      });
    });

    it("keeps one record per project", async () => {
      await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, filledLessonRecord(1));
      expect(await repository.loadRecord(LESSON_OWNER, LESSON_OTHER_PROJECT)).toEqual({
        ok: true,
        record: null,
      });
    });

    it("refuses a record with a bad ending and writes nothing", async () => {
      const result = await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, {
        ...emptyLessonRecord(1),
        finished: { "beat-kick": { how: "maybe" as "did_it", at: 1 } },
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid_record" });
      expect(await repository.loadRecord(LESSON_OWNER, LESSON_PROJECT)).toEqual({
        ok: true,
        record: null,
      });
    });

    it("reports a stored record it cannot read, rather than a fresh one", async () => {
      await harness.seedStoredDocument(lessonRecordPath(LESSON_OWNER, LESSON_PROJECT), {
        version: 99,
      });
      expect(await repository.loadRecord(LESSON_OWNER, LESSON_PROJECT)).toMatchObject({
        ok: false,
        reason: "unreadable",
      });
    });

    it("keeps each user's records to themselves", async () => {
      await repository.saveRecord(LESSON_OWNER, LESSON_PROJECT, filledLessonRecord(1));
      const other = harness.repositoryFor(LESSON_OTHER_OWNER);
      expect(await other.loadRecord(LESSON_OTHER_OWNER, LESSON_PROJECT)).toEqual({
        ok: true,
        record: null,
      });
    });
  });
}
