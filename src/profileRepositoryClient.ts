import { isMockBackend } from "./devBackend";
import type { ProfileRepository } from "./persistence/profileRepository";

/**
 * The application's `ProfileRepository` (GRV-25), chosen the way
 * `favouritesRepositoryClient.ts` chooses the favourites store: the mock
 * backend gets the in-memory store, everything else (the emulator included)
 * gets Firestore. `firestoreProfileRepository.ts` is imported dynamically so
 * `firebase/firestore` stays out of any module graph that does not ask for it.
 *
 * Memoized, so every surface of one page load shares one store: the welcome
 * that saves a profile and the dashboard that reads it next agree in the mock
 * backend too.
 */

let cached: Promise<ProfileRepository> | null = null;

export function getProfileRepository(): Promise<ProfileRepository> {
  cached ??= createProfileRepository();
  return cached;
}

async function createProfileRepository(): Promise<ProfileRepository> {
  if (isMockBackend) {
    const { createInMemoryProfileRepository } = await import(
      "./persistence/inMemoryProfileRepository"
    );
    return createInMemoryProfileRepository();
  }
  const [{ FirestoreProfileRepository }, { db }] = await Promise.all([
    import("./persistence/firestoreProfileRepository"),
    import("./firebaseConfig"),
  ]);
  return new FirestoreProfileRepository(db);
}

/** Test-only: forget the memoized repository so each test starts fresh. */
export function __resetProfileRepositoryClientForTests(): void {
  cached = null;
}
