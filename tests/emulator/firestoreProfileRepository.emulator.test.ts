// The Firestore profile store against a real (local) Firestore instance
// (GRV-25).
//
// It runs the same contract suite as the in-memory store, through the real
// security rules, and then proves the rules themselves: a profile is its
// owner's alone, it lives at one document ID, and a write that is the wrong
// shape or over the note cap is refused.
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import type { Firestore } from "firebase/firestore";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirestoreProfileRepository } from "../../src/persistence/firestoreProfileRepository";
import {
  emptyProfile,
  encodeProfile,
  profileCollectionPath,
  profileDocumentPath,
} from "../../src/persistence/profileDocuments";
import {
  describeProfileRepositoryContract,
  filledProfile,
  PROFILE_OTHER_OWNER,
  PROFILE_OWNER,
} from "../../src/persistence/profileRepositoryContract";
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
  testEnv = await createTestEnvironment(emulatorProjectId("profile"));
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

function repositoryFor(uid: string): FirestoreProfileRepository {
  return new FirestoreProfileRepository(firestoreAs(uid), { clock });
}

describeProfileRepositoryContract("firestore", () => ({
  clock,
  repositoryFor,
  reset: async () => testEnv.clearFirestore(),
  seedStoredDocument: async (path, data) =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore() as unknown as Firestore, path), data);
    }),
}));

describe("the profile's security rules (GRV-25)", () => {
  it("refuses to read or write another user's profile", async () => {
    await repositoryFor(PROFILE_OWNER).saveProfile(PROFILE_OWNER, filledProfile(1));
    const stranger = repositoryFor(PROFILE_OTHER_OWNER);

    expect(await stranger.loadProfile(PROFILE_OWNER)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stranger.saveProfile(PROFILE_OWNER, emptyProfile(1))).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    await assertFails(
      deleteDoc(
        doc(firestoreAs(PROFILE_OTHER_OWNER), profileDocumentPath(PROFILE_OWNER)),
      ),
    );
    await assertFails(
      getDoc(
        doc(
          testEnv.unauthenticatedContext().firestore() as unknown as Firestore,
          profileDocumentPath(PROFILE_OWNER),
        ),
      ),
    );
  });

  it("lets the owner delete their profile", async () => {
    await repositoryFor(PROFILE_OWNER).saveProfile(PROFILE_OWNER, filledProfile(1));
    await assertSucceeds(
      deleteDoc(doc(firestoreAs(PROFILE_OWNER), profileDocumentPath(PROFILE_OWNER))),
    );
  });

  it("only accepts the one document ID", async () => {
    await assertFails(
      setDoc(
        doc(firestoreAs(PROFILE_OWNER), `${profileCollectionPath(PROFILE_OWNER)}/other`),
        encodeProfile(emptyProfile(1)),
      ),
    );
  });

  it("refuses a profile with an unknown field, too many notes, or a bad outcome", async () => {
    const db = firestoreAs(PROFILE_OWNER);
    const path = profileDocumentPath(PROFILE_OWNER);
    const valid = encodeProfile(emptyProfile(1));
    await assertSucceeds(setDoc(doc(db, path), valid));
    await assertFails(setDoc(doc(db, path), { ...valid, projectId: "prj_x" }));
    await assertFails(
      setDoc(doc(db, path), {
        ...valid,
        notes: Array.from({ length: 21 }, (_, index) => ({
          id: `n${index}`,
          text: "x",
          createdAt: 1,
        })),
      }),
    );
    await assertFails(setDoc(doc(db, path), { ...valid, onboarding: "maybe" }));
    await assertFails(setDoc(doc(db, path), { ...valid, schemaVersion: 2 }));
    await assertFails(
      setDoc(doc(db, path), {
        ...valid,
        memory: { ...(valid.memory as object), mood: "happy" },
      }),
    );
  });
});
