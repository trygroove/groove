// Firebase Emulator suite for user data (#282): personal packs in Firestore,
// their audio in Cloud Storage, and the per-account usage total that
// `storage.rules` reads across services to enforce the 1 GB allowance.
//
// Needs both the Firestore and the Storage emulator (`bun run test:emulator`
// starts both), because the storage rules read the usage document out of
// Firestore. Each test writes its own object paths: the Storage emulator's
// `clearStorage()` does not reliably forget an object's metadata between
// tests, so a reused path can look like an overwrite to the next one.
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  listAll,
  ref,
  updateMetadata,
  uploadBytes,
} from "firebase/storage";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_PACK_SOUNDS,
  USER_DATA_CAP_BYTES,
  usageDocPath,
} from "../../src/userData/userData";
import {
  anonymousContext,
  assertFails,
  assertSucceeds,
  createTestEnvironment,
  EMULATOR_PROJECT_ID,
  registeredContext,
} from "./setup";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  // The emulators' own project, not a per-file one like the other suites use:
  // the Storage emulator answers `storage.rules`' `firestore.get()` from the
  // project it was started with, so a usage document seeded anywhere else is
  // invisible to the allowance check. No other file in this suite uses it.
  testEnv = await createTestEnvironment(EMULATOR_PROJECT_ID, {
    storage: true,
  });
});

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

afterAll(async () => {
  await testEnv.cleanup();
});

const PACK = "pak_aaaaaaaaaaaaaaaaaaaaa";
const WAV = { contentType: "audio/wav" };

function pack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: PACK,
    kind: "user",
    name: "Field Recordings",
    version: "1.0.0",
    assets: [],
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function seedUsage(uid: string, totalBytes: number) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), usageDocPath(uid)), {
      totalBytes,
      byKind: { packs: totalBytes },
      updatedAt: 0,
    });
  });
}

const audio = (bytes = 64) => new Uint8Array(bytes).fill(1);
/** A fresh asset ID per call, so no test meets an object another one left. */
let assetCount = 0;
const freshAsset = () => `ast_${String(++assetCount).padStart(21, "0")}`;
const audioPath = (uid: string, assetId = freshAsset()) =>
  `users/${uid}/packs/${PACK}/${assetId}`;

describe("firestore.rules: users/{uid}/packs", () => {
  it("lets a registered account create, rename and read its own pack", async () => {
    const db = registeredContext(testEnv, "u1").firestore();
    const ref = doc(db, "users", "u1", "packs", PACK);
    await assertSucceeds(setDoc(ref, pack()));
    await assertSucceeds(setDoc(ref, pack({ name: "Renamed", version: "1.1.0" })));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(deleteDoc(ref));
  });

  it("refuses a guest a pack of their own", async () => {
    const db = anonymousContext(testEnv, "anon").firestore();
    await assertFails(setDoc(doc(db, "users", "anon", "packs", PACK), pack()));
  });

  it("keeps one user's packs from every other user", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", "u1", "packs", PACK), pack());
    });
    const other = registeredContext(testEnv, "u2").firestore();
    await assertFails(getDoc(doc(other, "users", "u1", "packs", PACK)));
    await assertFails(setDoc(doc(other, "users", "u1", "packs", PACK), pack()));
    await assertFails(deleteDoc(doc(other, "users", "u1", "packs", PACK)));
    const nobody = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(nobody, "users", "u1", "packs", PACK)));
  });

  it("refuses a malformed pack", async () => {
    const db = registeredContext(testEnv, "u1").firestore();
    const ref = doc(db, "users", "u1", "packs", PACK);
    await assertFails(setDoc(ref, pack({ kind: "factory" })));
    await assertFails(setDoc(ref, pack({ name: "" })));
    await assertFails(setDoc(ref, pack({ version: "one" })));
    await assertFails(setDoc(ref, pack({ id: "pak_bbbbbbbbbbbbbbbbbbbbb" })));
    await assertFails(setDoc(ref, pack({ extra: true })));
  });

  it("holds a pack to as many sounds as one document safely fits", async () => {
    const db = registeredContext(testEnv, "u1").firestore();
    const ref = doc(db, "users", "u1", "packs", PACK);
    const sounds = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `ast_${index}` }));
    await assertSucceeds(setDoc(ref, pack({ assets: sounds(MAX_PACK_SOUNDS) })));
    await assertFails(setDoc(ref, pack({ assets: sounds(MAX_PACK_SOUNDS + 1) })));
  });

  it("lets the owner read their usage and nobody write it", async () => {
    await seedUsage("u1", 10);
    const owner = registeredContext(testEnv, "u1").firestore();
    await assertSucceeds(getDoc(doc(owner, usageDocPath("u1"))));
    await assertFails(
      setDoc(doc(owner, usageDocPath("u1")), { totalBytes: 0, byKind: {}, updatedAt: 0 }),
    );
    const other = registeredContext(testEnv, "u2").firestore();
    await assertFails(getDoc(doc(other, usageDocPath("u1"))));
  });
});

describe("storage.rules: users/{uid}/packs", () => {
  it("lets a registered account store, read and delete its own audio", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    const object = ref(storage, audioPath("u1"));
    await assertSucceeds(uploadBytes(object, audio(), WAV));
    await assertSucceeds(getBytes(object));
    await assertSucceeds(deleteObject(object));
  });

  it("refuses a guest any audio", async () => {
    const storage = anonymousContext(testEnv, "anon").storage();
    await assertFails(uploadBytes(ref(storage, audioPath("anon")), audio(), WAV));
  });

  it("refuses writing into, or reading from, another user's space", async () => {
    const owner = registeredContext(testEnv, "u1").storage();
    const stored = audioPath("u1");
    await assertSucceeds(uploadBytes(ref(owner, stored), audio(), WAV));
    const other = registeredContext(testEnv, "u2").storage();
    await assertFails(getBytes(ref(other, stored)));
    await assertFails(uploadBytes(ref(other, audioPath("u1")), audio(), WAV));
    await assertFails(deleteObject(ref(other, stored)));
    const nobody = testEnv.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(nobody, stored)));
  });

  it("refuses what is not audio, and empty files", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(
      uploadBytes(ref(storage, audioPath("u1")), audio(), { contentType: "text/html" }),
    );
    await assertFails(uploadBytes(ref(storage, audioPath("u1")), new Uint8Array(0), WAV));
  });

  it("refuses a file over the per-file limit", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(
      uploadBytes(ref(storage, audioPath("u1")), audio(MAX_IMPORT_FILE_BYTES + 1), WAV),
    );
  });

  it("never overwrites a stored sound", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    const once = audioPath("u1");
    await assertSucceeds(uploadBytes(ref(storage, once), audio(), WAV));
    await assertFails(uploadBytes(ref(storage, once), audio(32), WAV));
  });

  it("refuses a write that would take the account over its allowance", async () => {
    await seedUsage("u1", USER_DATA_CAP_BYTES - 100);
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(uploadBytes(ref(storage, audioPath("u1")), audio(101), WAV));
    await assertSucceeds(uploadBytes(ref(storage, audioPath("u1")), audio(100), WAV));
  });

  it("refuses an upload from someone signed out", async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(storage, audioPath("u1")), audio(), WAV));
  });

  it("refuses rewriting a stored sound's metadata, or listing another user's folder", async () => {
    const owner = registeredContext(testEnv, "u1").storage();
    const stored = audioPath("u1");
    await assertSucceeds(uploadBytes(ref(owner, stored), audio(), WAV));
    await assertFails(updateMetadata(ref(owner, stored), { contentType: "text/html" }));
    const other = registeredContext(testEnv, "u2").storage();
    await assertFails(listAll(ref(other, `users/u1/packs/${PACK}`)));
  });

  it("refuses audio filed outside the one pack folder depth the rules name", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(
      uploadBytes(
        ref(storage, `users/u1/packs/${PACK}/nested/${freshAsset()}`),
        audio(),
        WAV,
      ),
    );
    await assertFails(
      uploadBytes(ref(storage, `users/u1/${freshAsset()}`), audio(), WAV),
    );
    await assertFails(
      uploadBytes(ref(storage, `users/u1/recordings/${freshAsset()}`), audio(), WAV),
    );
  });

  it("refuses going round the allowance by uploading into another account's space", async () => {
    await seedUsage("u1", USER_DATA_CAP_BYTES);
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(uploadBytes(ref(storage, audioPath("u1")), audio(1), WAV));
    await assertFails(uploadBytes(ref(storage, audioPath("u2")), audio(1), WAV));
  });

  it("keeps the factory library read-only and the rest of the bucket shut", async () => {
    const storage = registeredContext(testEnv, "u1").storage();
    await assertFails(uploadBytes(ref(storage, "library/audio/x.ogg"), audio(), WAV));
    await assertFails(uploadBytes(ref(storage, "users/u1/secrets/x"), audio(), WAV));
    await assertFails(deleteObject(ref(storage, "library/audio/x.ogg")));
    const nobody = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(nobody, "library/audio/x.ogg"), audio(), WAV));
    await assertFails(getBytes(ref(nobody, "users/u1/secrets/x")));
  });
});
