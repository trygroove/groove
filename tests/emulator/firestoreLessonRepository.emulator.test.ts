// The Firestore lesson record store against a real (local) Firestore
// instance (GRV-190).
//
// It runs the same contract suite as the in-memory store, through the real
// security rules, and then proves the rules themselves: a record is its
// owner's alone, and a write that is the wrong shape is refused.
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import type { Firestore } from "firebase/firestore";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirestoreLessonRepository } from "../../src/persistence/firestoreLessonRepository";
import {
  emptyLessonRecord,
  encodeLessonRecord,
  lessonRecordPath,
} from "../../src/persistence/lessonDocuments";
import {
  describeLessonRepositoryContract,
  filledLessonRecord,
  LESSON_OTHER_OWNER,
  LESSON_OWNER,
  LESSON_PROJECT,
} from "../../src/persistence/lessonRepositoryContract";
import { createManualClock } from "../../src/shared/clock";
import {
  assertFails,
  assertSucceeds,
  createTestEnvironment,
  emulatorProjectId,
} from "./setup";

let testEnv: RulesTestEnvironment;
const clock = createManualClock(1_700_000_000_000);

beforeAll(async () => {
  testEnv = await createTestEnvironment(emulatorProjectId("lessons"));
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

function firestoreAs(uid: string): Firestore {
  return testEnv.authenticatedContext(uid).firestore() as unknown as Firestore;
}

function repositoryFor(uid: string): FirestoreLessonRepository {
  return new FirestoreLessonRepository(firestoreAs(uid), { clock });
}

describeLessonRepositoryContract("firestore", () => ({
  clock,
  repositoryFor,
  reset: async () => testEnv.clearFirestore(),
  seedStoredDocument: async (path, data) =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore() as unknown as Firestore, path), data);
    }),
}));

describe("the lesson record's security rules (GRV-190)", () => {
  const path = lessonRecordPath(LESSON_OWNER, LESSON_PROJECT);

  it("lets the owner read, write and delete their record", async () => {
    const db = firestoreAs(LESSON_OWNER);
    await assertSucceeds(
      setDoc(doc(db, path), encodeLessonRecord(filledLessonRecord(1))),
    );
    await assertSucceeds(getDoc(doc(db, path)));
    await assertSucceeds(deleteDoc(doc(db, path)));
  });

  it("refuses to read or write another user's record", async () => {
    await repositoryFor(LESSON_OWNER).saveRecord(
      LESSON_OWNER,
      LESSON_PROJECT,
      filledLessonRecord(1),
    );
    const stranger = repositoryFor(LESSON_OTHER_OWNER);
    expect(await stranger.loadRecord(LESSON_OWNER, LESSON_PROJECT)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await stranger.saveRecord(LESSON_OWNER, LESSON_PROJECT, emptyLessonRecord(1)),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    await assertFails(deleteDoc(doc(firestoreAs(LESSON_OTHER_OWNER), path)));
    await assertFails(
      getDoc(
        doc(testEnv.unauthenticatedContext().firestore() as unknown as Firestore, path),
      ),
    );
  });

  it("refuses a record with an unknown field, another version or a malformed lesson", async () => {
    const db = firestoreAs(LESSON_OWNER);
    const valid = encodeLessonRecord(filledLessonRecord(1));
    await assertSucceeds(setDoc(doc(db, path), valid));
    await assertFails(setDoc(doc(db, path), { ...valid, projectName: "Mine" }));
    await assertFails(setDoc(doc(db, path), { ...valid, version: 2 }));
    await assertFails(setDoc(doc(db, path), { ...valid, finished: ["beat-kick"] }));
    await assertFails(
      setDoc(doc(db, path), {
        ...valid,
        underWay: { ...(valid.underWay as object), chapterIndex: "one" },
      }),
    );
    await assertFails(
      setDoc(doc(db, path), {
        ...valid,
        underWay: { ...(valid.underWay as object), mood: "happy" },
      }),
    );
    const { updatedAt: _missing, ...partial } = valid;
    await assertFails(setDoc(doc(db, path), partial));
  });
});
