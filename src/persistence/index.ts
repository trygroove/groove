/**
 * The schema-v1 persistence boundary (PRD section 9.9).
 *
 * `documents.ts` owns the Firestore layout, `projectRepository.ts` the contract
 * every store satisfies, `autosave.ts` the optimistic save behavior PRJ-03
 * requires, and `migrations.ts` the forward-migration harness PRJ-04 requires.
 *
 * `favouriteDocuments.ts` and `favouritesRepository.ts` are the same pair for a
 * user's favourite sounds (LIB-011), which live under the user, not a project.
 *
 * `profileDocuments.ts` and `profileRepository.ts` are the pair again for a
 * producer's profile: onboarding and what Cue remembers (GRV-25).
 *
 * `firestoreProjectRepository.ts`, `firestoreFavouritesRepository.ts` and
 * `firestoreProfileRepository.ts` are deliberately not re-exported here: they
 * are the only modules in this directory that import `firebase/firestore`, and
 * keeping them off the barrel means unit tests, the audio engine, and the
 * renderer never pull Firebase into their module graph. Import them directly
 * where a real backend is actually wired up.
 */

export * from "./autosave";
export * from "./documentSize";
export * from "./documents";
export * from "./favouriteDocuments";
export * from "./favouritesRepository";
export * from "./inMemoryFavouritesRepository";
export * from "./inMemoryProfileRepository";
export * from "./inMemoryProjectRepository";
export * from "./migrations";
export * from "./profileDocuments";
export * from "./profileRepository";
export * from "./projectRepository";
