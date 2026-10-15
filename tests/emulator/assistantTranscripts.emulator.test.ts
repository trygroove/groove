// The assistant's transcript store (GRV-8) against a real (local) Firestore.
//
// Two halves. The rules: no client reaches `assistantTranscripts` or
// `assistantPreferences`, the owner included, so a browser can neither write
// a transcript, nor give itself a "yes" the disclosure did not, nor read
// anyone's records; an admin reads them only through the
// `assistantTranscriptsAdmin` callable (GRV-98), never the rules. And the
// store itself, over the Firestore store the Cloud
// Functions use (`functions/src/transcriptStore.ts`) through the admin SDK,
// running the same contract suite as the in-memory store: retention only on
// a current "yes", opting out mid-conversation, a racing opt-out, the 30-day
// expiry, and project and account deletion, with real transactions.
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { firestoreTranscriptStore } from "../../functions/src/transcriptStore";
import { describeTranscriptStoreContract } from "../../src/assistant/transcriptStoreContract";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  ASSISTANT_PREFERENCES_COLLECTION,
  ASSISTANT_TRANSCRIPTS_COLLECTION,
  preferenceDocPath,
  type TranscriptRecord,
  transcriptDocPath,
  transcriptRecordFor,
} from "../../src/assistant/transcripts";
import {
  anonymousContext,
  assertFails,
  createTestEnvironment,
  emulatorProjectId,
  registeredContext,
} from "./setup";

const PROJECT_ID = emulatorProjectId("transcripts");

let testEnv: RulesTestEnvironment;
const adminApp = initializeApp({ projectId: PROJECT_ID }, "assistant-transcripts");
const db = getFirestore(adminApp);

beforeAll(async () => {
  testEnv = await createTestEnvironment(PROJECT_ID);
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
  await deleteApp(adminApp);
});

const OWNER = "producer-uid";
const OTHER = "someone-else-uid";
const AT = Date.UTC(2026, 9, 9);

const RECORD = transcriptRecordFor({
  uid: OWNER,
  session: {
    conversationId: "conversation-1",
    turnId: "turn-0001",
    projectId: "prj_one",
    internal: false,
  },
  internalAccount: false,
  projectRevision: 1,
  userMessage: "Make it groove",
  reply: "Try swing.",
  stopReason: "end_turn",
  proposal: null,
  model: "claude-sonnet-5",
  promptVersion: "1",
  receivedAt: AT,
});

const YES = {
  schemaVersion: 1,
  retain: true,
  disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
  answeredAt: AT,
};

describe("assistant transcript rules", () => {
  async function seed() {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await setDoc(doc(firestore, transcriptDocPath(OWNER, RECORD.turnId)), RECORD);
      await setDoc(doc(firestore, preferenceDocPath(OWNER)), YES);
    });
  }

  it("denies the owner reading or writing its own transcripts", async () => {
    await seed();
    const firestore = registeredContext(testEnv, OWNER).firestore();
    await assertFails(getDoc(doc(firestore, transcriptDocPath(OWNER, RECORD.turnId))));
    await assertFails(
      setDoc(doc(firestore, transcriptDocPath(OWNER, "turn-0002")), {
        ...RECORD,
        turnId: "turn-0002",
      }),
    );
  });

  it("denies another account, a guest and no one reading the owner's transcripts", async () => {
    await seed();
    for (const context of [
      registeredContext(testEnv, OTHER),
      anonymousContext(testEnv, OTHER),
      testEnv.unauthenticatedContext(),
    ]) {
      await assertFails(
        getDoc(doc(context.firestore(), transcriptDocPath(OWNER, RECORD.turnId))),
      );
    }
  });

  it("denies an admin reading transcripts directly: the callable is the only way in (GRV-98)", async () => {
    await seed();
    const admin = testEnv.authenticatedContext("admin-uid", {
      admin: true,
      firebase: { sign_in_provider: "google.com" },
    });
    await assertFails(
      getDoc(doc(admin.firestore(), transcriptDocPath(OWNER, RECORD.turnId))),
    );
    await assertFails(
      getDocs(collection(admin.firestore(), ASSISTANT_TRANSCRIPTS_COLLECTION)),
    );
  });

  it("denies a client giving itself the retention its answer does not allow", async () => {
    await seed();
    await db.doc(preferenceDocPath(OTHER)).set({ ...YES, retain: false });
    for (const [uid, context] of [
      [OTHER, registeredContext(testEnv, OTHER)],
      [OWNER, registeredContext(testEnv, OWNER)],
    ] as const) {
      const ref = doc(context.firestore(), preferenceDocPath(uid));
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, YES));
    }
  });
});

async function clearTranscriptCollections() {
  for (const name of [
    ASSISTANT_TRANSCRIPTS_COLLECTION,
    ASSISTANT_PREFERENCES_COLLECTION,
  ]) {
    const snapshot = await db.collection(name).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }
}

describeTranscriptStoreContract("firestore", {
  store: async () => {
    await clearTranscriptCollections();
    return firestoreTranscriptStore(db);
  },
  records: async () => {
    const snapshot = await db.collection(ASSISTANT_TRANSCRIPTS_COLLECTION).get();
    return snapshot.docs
      .map((document) => document.data() as TranscriptRecord)
      .sort((a, b) => a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId));
  },
  rawPreference: async (uid, value) => {
    await db.doc(preferenceDocPath(uid)).set(value as Record<string, unknown>);
  },
});
