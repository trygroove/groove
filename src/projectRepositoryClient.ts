import { isMockBackend } from "./devBackend";
import type { ProjectRepository } from "./persistence/projectRepository";

/**
 * The application's `ProjectRepository` (PRD section 9.9; `FND-009`).
 *
 * Mirrors `src/auth/authService.ts`'s mock/Firestore switch, but for the
 * schema-v1 repository boundary: `VITE_DEV_BACKEND=mock` (the browser E2E
 * suite, local UI development) gets the in-memory repository, everything
 * else — including the emulator — gets Firestore.
 *
 * `firestoreProjectRepository.ts` is deliberately not imported at the top of
 * this module — `src/persistence`'s own barrel omits it for the same reason
 * (see that directory's `index.ts`): importing `firebase/firestore` must stay
 * opt-in per module, not ambient. The dynamic `import()` below is this
 * module's version of the same rule, matching the pattern
 * `src/auth/authService.ts` already uses for exactly this reason.
 *
 * Memoized so the dashboard and the editor share one repository instance per
 * page load — important for the in-memory repository, whose state lives only
 * in that instance.
 */

let cached: Promise<ProjectRepository> | null = null;

export function getProjectRepository(): Promise<ProjectRepository> {
  if (!cached) {
    const pending = createProjectRepository();
    cached = pending;
    // A failed chunk import (a tab left open across a deploy, GRV-137) must
    // not be replayed for the life of the tab: forget it so the next call
    // tries again.
    pending.catch(() => {
      if (cached === pending) cached = null;
    });
  }
  return cached;
}

async function createProjectRepository(): Promise<ProjectRepository> {
  if (isMockBackend) {
    const { createInMemoryProjectRepository } = await import(
      "./persistence/inMemoryProjectRepository"
    );
    return createInMemoryProjectRepository();
  }
  const [{ FirestoreProjectRepository }, { db }] = await Promise.all([
    import("./persistence/firestoreProjectRepository"),
    import("./firebaseConfig"),
  ]);
  return new FirestoreProjectRepository(db);
}

/** Test-only: forget the memoized repository so each test starts fresh. */
export function __resetProjectRepositoryClientForTests(): void {
  cached = null;
}
