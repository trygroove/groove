// The security-rules audit (GRV-7): every collection in `firestore.rules` and
// every path in `storage.rules` is named here, with the suite that tests its
// owner access and its abuse cases, and the abuse cases no other suite covers
// are tested below.
//
// The register is checked against the rules files themselves, so a new
// `match` block without an entry here fails this suite: adding a collection or
// a Storage path means saying which tests guard it.
//
// What "abuse" covers, per surface: another user's reads and writes, no
// sign-in at all, an account that is not on the alpha allowlist, a write that
// breaks the schema-v1 document shape or Firestore's size limit, a write that
// goes around the revision check, and a write that goes around the usage cap
// (#282). Storage uploads over the size and type limits are in
// `userDataRules.emulator.test.ts`, which owns the emulators' own project (the
// one `storage.rules` reads the usage total from).
//
// The allowlist is enforced at sign-in, by the blocking `beforeSignIn`
// function (`src/access/signInGate.ts`); the rules take a Firebase ID token as
// proof the account passed it. What an account that is not on the list can do
// is therefore what any other signed-in stranger can: nothing of anyone
// else's, and nothing to the list itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowlistDocPath } from "../../src/access/allowlist";
import { SCHEMA_VERSION } from "../../src/domain/entities";
import { usageDocPath } from "../../src/userData/userData";
import {
  assertFails,
  assertSucceeds,
  createTestEnvironment,
  emulatorProjectId,
  registeredContext,
} from "./setup";

/**
 * Every `match` path in `firestore.rules` and `storage.rules`, and the suites
 * that test it. The catch-all deny in `storage.rules` is a path like any other.
 */
const FIRESTORE_SURFACES: Record<string, string> = {
  "/databases/{database}/documents": "the root: holds no documents of its own",
  "/databases/{database}/documents/users/{uid}":
    "this file (the user document itself is unreachable)",
  "/databases/{database}/documents/users/{uid}/packs/{packId}":
    "userDataRules.emulator.test.ts, this file",
  "/databases/{database}/documents/users/{uid}/usage/{document=**}":
    "userDataRules.emulator.test.ts, this file",
  "/databases/{database}/documents/users/{uid}/profile/{document}":
    "firestoreProfileRepository.emulator.test.ts, this file",
  "/databases/{database}/documents/projects/{projectId}":
    "firestoreRules.emulator.test.ts, firestoreProjectRepository.emulator.test.ts, this file",
  "/databases/{database}/documents/projects/{projectId}/song/{songId}":
    "firestoreRules.emulator.test.ts, this file",
  "/databases/{database}/documents/projects/{projectId}/clips/{clipId}":
    "firestoreRules.emulator.test.ts, this file",
  "/databases/{database}/documents/projects/{projectId}/arrangement/{trackId}":
    "firestoreRules.emulator.test.ts, this file",
  "/databases/{database}/documents/users/{userId}/favourites/{favouriteId}":
    "firestoreRules.emulator.test.ts, firestoreFavouritesRepository.emulator.test.ts, this file",
  "/databases/{database}/documents/allowlist/{email}":
    "allowlistRules.emulator.test.ts, firestoreAccessRepository.emulator.test.ts",
  "/databases/{database}/documents/signInAttempts/{email}":
    "allowlistRules.emulator.test.ts",
  "/databases/{database}/documents/assistantUsage/{uid}":
    "assistantGuards.emulator.test.ts",
  "/databases/{database}/documents/assistantSpend/{day}":
    "assistantGuards.emulator.test.ts",
  "/databases/{database}/documents/assistantControl/{document}":
    "assistantGuards.emulator.test.ts",
  "/databases/{database}/documents/assistantTranscripts/{transcriptId}":
    "assistantTranscripts.emulator.test.ts",
  "/databases/{database}/documents/assistantPreferences/{uid}":
    "assistantTranscripts.emulator.test.ts",
};

const STORAGE_SURFACES: Record<string, string> = {
  "/b/{bucket}/o": "the root: holds no objects of its own",
  "/b/{bucket}/o/library/{allPaths=**}": "userDataRules.emulator.test.ts",
  "/b/{bucket}/o/users/{uid}/packs/{packId}/{assetId}":
    "userDataRules.emulator.test.ts, userLibraryRepository.emulator.test.ts",
  "/b/{bucket}/o/{allPaths=**}": "userDataRules.emulator.test.ts",
};

/**
 * The full path of every `match` block in a rules file, nested blocks joined
 * onto their parents. Comments are dropped first so a brace in prose cannot
 * unbalance the count.
 */
function matchPaths(rulesFile: string): string[] {
  const source = readFileSync(resolve(process.cwd(), rulesFile), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""));
  const paths: string[] = [];
  const open: { path: string; depth: number }[] = [];
  let depth = 0;
  for (const line of source) {
    const match = /^\s*match\s+(\S+)\s*\{/.exec(line);
    if (match) {
      const parent = open.at(-1)?.path ?? "";
      const path = parent + match[1];
      paths.push(path);
      open.push({ path, depth });
    }
    // A path's own `{wildcards}` are not blocks.
    const blocks = match ? line.replace(match[1], "") : line;
    for (const character of blocks) {
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (open.length > 0 && open[open.length - 1].depth === depth) open.pop();
      }
    }
  }
  return paths;
}

describe("the rules audit register", () => {
  it("names every Firestore collection the rules match", () => {
    expect(matchPaths("firestore.rules").sort()).toEqual(
      Object.keys(FIRESTORE_SURFACES).sort(),
    );
  });

  it("names every Storage path the rules match", () => {
    expect(matchPaths("storage.rules").sort()).toEqual(
      Object.keys(STORAGE_SURFACES).sort(),
    );
  });
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await createTestEnvironment(emulatorProjectId("audit"));
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

const OWNER = "owner-a";
const COLLABORATOR = "collaborator-b";
const STRANGER = "stranger-c";
const PROJECT = "prj_aaaaaaaaaaaaaaaaaaaaa";
const CLIP = "clp_aaaaaaaaaaaaaaaaaaaaa";
const TRACK = "trk_aaaaaaaaaaaaaaaaaaaaa";
const CREATED_AT = 1_700_000_000_000;

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 3,
    name: "Audit fixture",
    ownerId: OWNER,
    collaboratorIds: [COLLABORATOR],
    createdAt: CREATED_AT,
    modifiedAt: CREATED_AT,
    template: null,
    genre: null,
    packDependencies: [],
    addedPacks: [],
    ...overrides,
  };
}

function child(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    schemaVersion: SCHEMA_VERSION,
    revision: 3,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const projectPath = `projects/${PROJECT}`;
const songPath = `${projectPath}/song/current`;
const clipPath = `${projectPath}/clips/${CLIP}`;
const chunkPath = `${projectPath}/arrangement/${TRACK}`;

/** The project at revision 3, with a song, a clip and an arrangement chunk. */
async function seedProject() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, projectPath), metadata());
    await setDoc(doc(db, songPath), child({ tempo: 120 }));
    await setDoc(doc(db, clipPath), child({ id: CLIP }));
    await setDoc(doc(db, chunkPath), child({ trackId: TRACK, placements: [] }));
  });
}

function firestoreAs(uid: string) {
  return registeredContext(testEnv, uid).firestore();
}

/** Bytes past Firestore's 1 MiB per-document limit, in one string field. */
const OVER_ONE_MIB = "x".repeat(1_048_576);

describe("projects: the revision check cannot be bypassed", () => {
  it("takes a save that moves the revision on by exactly one, as the repository writes it", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    const batch = writeBatch(db);
    batch.set(doc(db, clipPath), child({ id: CLIP, revision: 4 }));
    batch.set(
      doc(db, projectPath),
      metadata({ revision: 4, modifiedAt: CREATED_AT + 1 }),
    );
    await assertSucceeds(batch.commit());
  });

  it("refuses a metadata save that keeps the revision", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    await assertFails(setDoc(doc(db, projectPath), metadata({ name: "Same revision" })));
  });

  it("refuses a metadata save that jumps the revision ahead", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    await assertFails(setDoc(doc(db, projectPath), metadata({ revision: 9 })));
  });

  it("refuses changing a child document without moving the project's revision", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    // Stamped at the current revision, or at the next one, but on its own.
    await assertFails(setDoc(doc(db, clipPath), child({ id: CLIP, notes: [] })));
    await assertFails(setDoc(doc(db, clipPath), child({ id: CLIP, revision: 4 })));
    await assertFails(setDoc(doc(db, songPath), child({ tempo: 90 })));
    await assertFails(
      setDoc(doc(db, chunkPath), child({ trackId: TRACK, placements: [], revision: 4 })),
    );
  });

  it("refuses a child document stamped with a revision the project is not at", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    const batch = writeBatch(db);
    batch.set(doc(db, clipPath), child({ id: CLIP, revision: 7 }));
    batch.set(doc(db, projectPath), metadata({ revision: 4 }));
    await assertFails(batch.commit());
    // A new clip filed at an old revision is refused too.
    await assertFails(
      setDoc(
        doc(db, `${projectPath}/clips/clp_bbbbbbbbbbbbbbbbbbbbb`),
        child({ id: "clp_bbbbbbbbbbbbbbbbbbbbb", revision: 2 }),
      ),
    );
  });

  it("refuses a collaborator removing a document without moving the revision", async () => {
    await seedProject();
    const db = firestoreAs(COLLABORATOR);
    await assertFails(deleteDoc(doc(db, clipPath)));
    await assertFails(deleteDoc(doc(db, songPath)));
    const batch = writeBatch(db);
    batch.delete(doc(db, clipPath));
    batch.set(doc(db, projectPath), metadata({ revision: 4 }));
    await assertSucceeds(batch.commit());
  });

  it("lets the owner delete the whole project, children first", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    const batch = writeBatch(db);
    for (const path of [clipPath, chunkPath, songPath, projectPath]) {
      batch.delete(doc(db, path));
    }
    await assertSucceeds(batch.commit());
  });

  it("evaluates a large first save in one batch, as createProject writes it", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), projectPath), metadata({ revision: 0 }));
    });
    const db = firestoreAs(OWNER);
    const batch = writeBatch(db);
    batch.set(doc(db, songPath), child({ revision: 0 }));
    for (let index = 0; index < 60; index += 1) {
      const id = `clp_${String(index).padStart(21, "0")}`;
      batch.set(doc(db, `${projectPath}/clips/${id}`), child({ id, revision: 0 }));
    }
    await assertSucceeds(batch.commit());
  });
});

describe("projects: membership and shape", () => {
  it("refuses changing when the project was created", async () => {
    await seedProject();
    const db = firestoreAs(OWNER);
    await assertFails(
      setDoc(doc(db, projectPath), metadata({ revision: 4, createdAt: CREATED_AT - 1 })),
    );
  });

  it("lets only the owner decide who else is a member", async () => {
    await seedProject();
    const collaborator = firestoreAs(COLLABORATOR);
    await assertFails(
      setDoc(
        doc(collaborator, projectPath),
        metadata({ revision: 4, collaboratorIds: [COLLABORATOR, STRANGER] }),
      ),
    );
    await assertFails(
      setDoc(
        doc(collaborator, projectPath),
        metadata({ revision: 4, collaboratorIds: [] }),
      ),
    );
    // A collaborator still saves; the owner still shares.
    await assertSucceeds(
      setDoc(doc(collaborator, projectPath), metadata({ revision: 4, name: "Renamed" })),
    );
    await assertSucceeds(
      setDoc(
        doc(firestoreAs(OWNER), projectPath),
        metadata({ revision: 5, collaboratorIds: [COLLABORATOR, STRANGER] }),
      ),
    );
  });

  it("refuses listing projects without asking for one's own", async () => {
    await seedProject();
    const db = firestoreAs(STRANGER);
    await assertFails(getDocs(collection(db, "projects")));
    await assertFails(
      getDocs(query(collection(db, "projects"), where("ownerId", "==", OWNER))),
    );
    await assertSucceeds(
      getDocs(query(collection(db, "projects"), where("ownerId", "==", STRANGER))),
    );
  });

  it("refuses a stranger every tier, and someone signed out everything", async () => {
    await seedProject();
    for (const db of [
      firestoreAs(STRANGER),
      testEnv.unauthenticatedContext().firestore(),
    ]) {
      for (const path of [projectPath, songPath, clipPath, chunkPath]) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(deleteDoc(doc(db, path)));
      }
      await assertFails(getDocs(collection(db, `${projectPath}/clips`)));
      const batch = writeBatch(db);
      batch.set(doc(db, clipPath), child({ id: CLIP, revision: 4 }));
      batch.set(doc(db, projectPath), metadata({ revision: 4 }));
      await assertFails(batch.commit());
    }
    await assertFails(
      setDoc(
        doc(testEnv.unauthenticatedContext().firestore(), "projects/prj_new"),
        metadata(),
      ),
    );
  });

  it("refuses a document over Firestore's size limit on any tier", async () => {
    // The rules cannot measure a document in bytes, so the schema-v1 budgets
    // (256 KiB a tier, `src/persistence/documentSize.ts`) are the client's
    // layout rule; what holds a client that ignores them is Firestore's own
    // 1 MiB limit, which refuses the write before the rules run.
    await seedProject();
    const db = firestoreAs(OWNER);
    await expect(
      setDoc(doc(db, projectPath), metadata({ revision: 4, name: OVER_ONE_MIB })),
    ).rejects.toThrow(/longer than|too large|exceeds/i);
    const batch = writeBatch(db);
    batch.set(doc(db, clipPath), child({ id: CLIP, revision: 4, padding: OVER_ONE_MIB }));
    batch.set(doc(db, projectPath), metadata({ revision: 4 }));
    await expect(batch.commit()).rejects.toThrow(/longer than|too large|exceeds/i);
    // The metadata name is held far below that by the rules themselves.
    await assertFails(
      setDoc(doc(db, projectPath), metadata({ revision: 4, name: "x".repeat(121) })),
    );
  });
});

describe("users/{uid}: nothing outside the named folders", () => {
  it("refuses the user document and any folder the rules do not name", async () => {
    const db = firestoreAs(OWNER);
    await assertFails(setDoc(doc(db, `users/${OWNER}`), { plan: "unlimited" }));
    await assertFails(getDoc(doc(db, `users/${OWNER}`)));
    await assertFails(setDoc(doc(db, `users/${OWNER}/recordings/r1`), { bytes: 1 }));
    await assertFails(setDoc(doc(db, `users/${OWNER}/stash/s1`), { blob: "x" }));
  });

  it("refuses creating, lowering or deleting one's own usage total", async () => {
    const db = firestoreAs(OWNER);
    const usage = doc(db, usageDocPath(OWNER));
    await assertFails(setDoc(usage, { totalBytes: 0, byKind: {}, updatedAt: 0 }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), usageDocPath(OWNER)), {
        totalBytes: 900,
        byKind: { packs: 900 },
        updatedAt: 0,
      });
    });
    await assertFails(setDoc(usage, { totalBytes: 0, byKind: {}, updatedAt: 0 }));
    await assertFails(deleteDoc(usage));
    await assertFails(setDoc(doc(db, `users/${OWNER}/usage/other`), { totalBytes: 0 }));
  });

  it("refuses a profile or favourite to someone signed out", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, `users/${OWNER}/profile/current`), {}));
    await assertFails(getDoc(doc(db, `users/${OWNER}/profile/current`)));
    await assertFails(getDocs(collection(db, `users/${OWNER}/favourites`)));
    await assertFails(getDocs(collection(db, `users/${OWNER}/packs`)));
  });
});

describe("an account that is not on the allowlist", () => {
  const UNLISTED = "unlisted@example.com";

  it("reaches nothing of anyone else's and cannot list itself", async () => {
    await seedProject();
    const db = firestoreAs("unlisted-uid");
    await assertFails(getDoc(doc(db, projectPath)));
    await assertFails(getDoc(doc(db, clipPath)));
    await assertFails(getDoc(doc(db, `users/${OWNER}/profile/current`)));
    await assertFails(getDocs(collection(db, `users/${OWNER}/packs`)));
    await assertFails(getDocs(collection(db, `users/${OWNER}/favourites`)));
    await assertFails(
      setDoc(doc(db, allowlistDocPath(UNLISTED)), { email: UNLISTED, addedAt: 1 }),
    );
    await assertFails(getDocs(collection(db, "signInAttempts")));
  });
});
