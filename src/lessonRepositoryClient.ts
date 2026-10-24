import { isMockBackend } from "./devBackend";
import type { LessonRepository } from "./persistence/lessonRepository";

/**
 * The application's `LessonRepository` (GRV-190), chosen the way
 * `favouritesRepositoryClient.ts` chooses the favourites store: the mock
 * backend gets the in-memory store, everything else (the emulator included)
 * gets Firestore. `firestoreLessonRepository.ts` is imported dynamically so
 * `firebase/firestore` stays out of any module graph that does not ask for it.
 *
 * Memoized, so every surface of one page load shares one store: an editor
 * reopened in the mock backend finds the lesson it left.
 */

let cached: Promise<LessonRepository> | null = null;

export function getLessonRepository(): Promise<LessonRepository> {
  cached ??= createLessonRepository();
  return cached;
}

async function createLessonRepository(): Promise<LessonRepository> {
  if (isMockBackend) {
    const { createInMemoryLessonRepository } = await import(
      "./persistence/inMemoryLessonRepository"
    );
    return createInMemoryLessonRepository();
  }
  const [{ FirestoreLessonRepository }, { db }] = await Promise.all([
    import("./persistence/firestoreLessonRepository"),
    import("./firebaseConfig"),
  ]);
  return new FirestoreLessonRepository(db);
}

/** Test-only: forget the memoized repository so each test starts fresh. */
export function __resetLessonRepositoryClientForTests(): void {
  cached = null;
}
