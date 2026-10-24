# Schema-v1 persistence

| Field | Value |
| --- | --- |
| Status | Implemented (`FND-004`) |
| Scope | The Firestore document layout, the repository boundary, optimistic autosave, and the migration harness |

Related documents: [Product principles](./prd.md), [core flows](./core-flows.md), [testing](./testing.md)

Code: [`src/persistence/`](../src/persistence). The canonical domain model it stores is [`src/domain/`](../src/domain); persistence never redefines a domain rule, it only decides where bytes live.

## Document layout

`src/persistence/documents.ts` is the checked-in mapping. Nothing else may build a Firestore path or document body for a project.

| Path | Contents | Written when |
| --- | --- | --- |
| `projects/{projectId}` | Name, owner, collaborators, created/modified time, schema version, current revision, template/genre, the pack dependency list (`packDependencies`: one pack ID and version per pack the project's assets resolve from), and the pack shelf (`addedPacks`: the packs the user has added to this project, a superset of the dependency list — [LIB-08](#packs-and-pack-qualified-assets)) | Metadata edits, and every `saveSong` — the dependency list is derived from the song's assets. The dashboard reads only this tier. |
| `projects/{projectId}/song/current` | Tempo, time signature, sections, tracks with instrument state, device chains, sends, mixer state, return buses, master, assets, and — while it fits — arrangement placements and automation | Structural and arrangement edits |
| `projects/{projectId}/clips/{clipId}` | One clip and its note or audio-loop content | Note and clip-content edits |
| `projects/{projectId}/arrangement/{trackId}` | One track's placements and its track-owned automation lanes | Only when the song document exceeds its budget |

Conventions that hold on every tier:

- **Ownership** lives on the metadata document alone (`ownerId`, `collaboratorIds`). Child documents inherit it and the security rules resolve the parent, so no tier can hold an owner its project disagrees with.
- **Schema version** (`schemaVersion`) is written on every document, so no reader can silently accept state it does not understand.
- **Revision** is on every document. Metadata holds the project's current revision; a child holds the revision it was written at; arrangement chunks always share their song document's revision, which makes a torn multi-document write detectable on read.
- **Timestamps** are integer epoch milliseconds (`createdAt`/`modifiedAt` on metadata, `updatedAt` on children), never Firestore `Timestamp`s — a Firebase type must never reach the domain model, and an integer field still sorts and queries.
- **`projectId`** is repeated on every child document, so a document copied between projects is rejected by both the rules and the decoder.
- The project ID is **not** duplicated as a metadata field: the document path already carries it, and a second copy could disagree.
- **Pack dependencies** belong on the metadata tier for the same reason ownership does: the dashboard, export, and a missing-pack warning need to know what a project requires without loading song state or clip content. See [Packs and pack-qualified assets](#packs-and-pack-qualified-assets) below.

`encodeProject` produces these documents from a `Project`; `decodeProject` reassembles one and runs it through the domain's `parseProject`, so persistence has no second, weaker definition of a valid project.

## Packs and pack-qualified assets

Library content is organized into **packs** (domain invariant 12), and `FND-002b` put that in schema v1. The domain model owns the rules; this section records where the bytes live.

The domain side, in [`src/domain/packs.ts`](../src/domain/packs.ts) and [`entities.ts`](../src/domain/entities.ts):

- A **`Pack`** has a `pak_` ID, name, `major.minor.patch` version, publisher, kind (`factory`, `user`, `third-party`), description, and one rights position covering every asset in it. A pack version is immutable content: republished audio or metadata is a new version. Packs are *library* entities — a project never stores pack records, so nothing in a stored project has to be kept in step with a catalogue.
- An **`Asset`** names its owning `packId` and the `packVersion` it resolved from. Asset identity is therefore pack-qualified: two packs may hold a sound of the same name without collision, and neither is renamed to avoid the other. The storage reference is still not identity (invariant 8).
- A project's **pack dependency list** is `metadata.packDependencies`: one `{ packId, version }` per pack its assets resolve from, at most one version per pack. It is *derived*, by `derivePackDependencies(song)`, and `parseProject` enforces both directions — an asset whose pack is undeclared, a declared version that disagrees with the asset, and a declared pack no asset uses are all rejected. Drift is an invalid project, not a project that quietly over-reports.
- A project's **pack shelf** is `metadata.addedPacks`: the packs the user has *added to this project*, as `{ packId, version }` entries, one version per pack. It answers a different question from the dependency list — "which packs has the user put on the shelf?" rather than "which packs does the project need to open?" — so a user can add a pack, browse it, and not yet use a sound from it, and that pack survives a reload. Unlike `packDependencies` the shelf is *maintained*, by the `pack.add`/`pack.remove` commands, not derived. But it is not free-form: `parseProject` requires it to be a **superset** of the dependency list at matching versions, so every used pack is always shelved. Adding an asset from a new pack shelves that pack automatically (`withDerivedPackDependencies` reconciles the shelf alongside the derived list); removing a pack whose assets are in use is refused, not silently dropped. `pack.setVersion` (#892) moves one pack's pin from one version to another: every asset the project carries from it and its shelf entry, in one revision, with the derived list following. It refuses a version the project does not pin, so it never leaves a pack at two versions, and its inverse is the same command with the versions swapped.
- **Unresolvable audio** is a reported state, never a dangling reference or a substitution. `resolvePackAvailability(project, availablePacks)` is answered per *asset* (LIB-10): the caller passes the pack versions it holds **and the asset IDs each one contains**, and a dependency resolves when every asset the project references from that pack is present in some version of it. So a pack that has *gained* sounds since the project pinned it resolves silently — the common case for a personal pack — while a pack the caller holds at no version at all is a `pack_unavailable` entry in `missing`, and a sound *deleted* from every version held is a `missingAssets` entry naming that asset. Both name the affected tracks and clips. LIB-05 still holds: an asset is immutable content, so resolving one from a later version returns the same audio, the project keeps pinning the version it recorded, and no later version's metadata is adopted. Presenting that state is `LOOP-013`.
- **A withdrawn factory pack** is one the published pack index no longer lists at any version (#78). `withdrawnFactoryPacks(project, index)` (`src/library/factoryAvailability.ts`) reports each as a `pack_unavailable` entry, and the editor shows it in its Missing sounds notice beside the personal sounds `userPackAvailability` reports. A sound dropped only from a factory pack's latest version is *not* missing: every pack version's manifest and every audio object are immutable, so the project's pinned version still delivers it. Export goes ahead when the editor reports missing sounds: a reported sound that cannot load renders as silence (`missingAssetIds` on the offline render), while any other sound that cannot load still fails the export.

Where a dependency is recomputed:

| Layer | What happens |
| --- | --- |
| Commands | `executeTransaction` re-derives the list once per transaction, before the invariant check, so the recompute is atomic with the edit that changed which packs the project uses. Undo and redo replay through the same path. An unchanged list is passed through by object identity, so a note edit is not mistaken for a metadata change. |
| Persistence | `saveSong` writes the derived list to the metadata document in the same revision-checked write as the song, so the two tiers can never disagree, and reconciles the shelf against it so a newly-used pack is shelved in the same revision. `saveMetadata` cannot set `packDependencies` — `ProjectMetadataPatch` has no such field — but it *can* set `addedPacks`, which is how a `pack.add`/`pack.remove` that touches no song state persists. |
| Rules | `firestore.rules` accepts `packDependencies` and `addedPacks` as lists. It cannot check either against the project's assets without reading the song document, so those checks belong to `decodeProject`/`parseProject`. |
| Dashboard | `buildProjectSummaryProjection` exposes it, so a project row or an export can warn about a missing pack from metadata alone. |

Delivering the shipped library as packs is `CNT-000b`; browsing by pack is `LOOP-013`. Nothing here models installation, entitlement, or purchase — the alpha's packs are all bundled factory packs.

## Size budget and the chunk boundary

`FND-004` owns these numbers; they live in `src/persistence/documentSize.ts`.

| Budget | Value | Why |
| --- | --- | --- |
| Firestore hard limit | 1,048,576 bytes | Platform limit; a larger write always fails |
| Song document | 262,144 bytes (256 KiB) | A quarter of the hard limit. The song document holds the structure a project keeps growing, so a budget near the limit would leave a project one edit away from being unwritable. |
| Arrangement chunk | 262,144 bytes | One track's arrangement is the smallest unit this layout can split, so the budget detects a track that has outgrown the layout rather than triggering a further split |
| Clip document | 262,144 bytes | The highest-frequency write path; kept small on purpose |

Sizes are measured with Firestore's own accounting (document name + field names and values + 32 bytes per document), not with JSON length, so a budget assertion means what it says.

**The chunk boundary.** The song document is built whole. If it exceeds its budget, *all* per-track arrangement content — placements, and automation lanes targeting a track, a device on a track, or one of its sends — moves into `arrangement/{trackId}` documents written at the same revision, and the song document records `arrangementChunked: true` plus the `chunkTrackIds` it wrote. The split is all-or-nothing so a reader has exactly one rule to follow. Automation on returns and the master bus stays in the song document: it is bounded by the number of buses and has no per-track chunk to live in.

Measured against the PRD reference project (50 tracks, ten minutes, 2,500 placements, 100 automation lanes), asserted in `src/persistence/songBudget.test.ts`:

| Document | Bytes |
| --- | --- |
| Song document if the arrangement stayed inline | ~534,000 (over budget — chunking is exercised, not hypothetical) |
| Song document after chunking | 13,501 |
| Largest of the 50 arrangement chunks | 10,718 |
| Largest clip document | 1,408 |
| Metadata document | 309 (including its pack dependency list) |
| `FND-009` slice fixture's song document | 1,078 (no chunks) |

If a *single track* ever exceeds the chunk budget, the write fails with `document_too_large` rather than being silently truncated or split further. Sub-chunking one track's arrangement is deliberately not implemented: no fixture reaches it, and an unproven mechanism is worse than an explicit failure.

## Repository boundary

`ProjectRepository` (`src/persistence/projectRepository.ts`) has two implementations — `InMemoryProjectRepository` for unit, component, and browser tests, and `FirestoreProjectRepository` for production — and both run the same contract suite (`projectRepositoryContract.ts`, executed by `src/persistence/inMemoryProjectRepository.test.ts` and `tests/emulator/firestoreProjectRepository.emulator.test.ts`). The in-memory store keeps *encoded* documents at their real paths, so it exercises the same encoding, chunking, and revision logic; only the transport differs.

Two rules shape the interface:

- **Every write is revision-checked.** The caller states the revision it wrote against; the repository applies the write and returns the new revision, or reports `revision_conflict` and changes nothing.
- **Tiers are written independently.** `saveClip` writes one clip document plus the metadata revision — never song structure.
- **A change set is atomic.** `saveChanges` writes any combination of tiers — metadata patch, song, clip documents, clip deletions — as **one** revision: every document lands or none does. The single-tier writes are `saveChanges` with one field set, so they stay one document each. Autosave sends everything it has queued through it, which is what keeps the store from ever holding a song whose placements point at clip documents that were not written, or a clip whose track the stored song has removed (#965).

`FirestoreProjectRepository` runs each revision-checked write in a Firestore transaction so the tier document and the revision bump commit together. Creating a project takes two steps — claim the metadata document, then write the remaining tiers — because the security rules resolve a child's owner from its parent and rule `get()`s see the database as it was before the write commits. If the second step fails, the claimed metadata document is removed rather than left as a project with no song.

**Loading drops a reference to a document that was never stored** rather than refusing the project (#965). `decodeProject` removes a clip document whose `trackId` names no track in the stored song, then a placement whose `clipId` names no stored clip, and reports what it removed as `dropped` on the load result (a placement count and the dropped clip IDs). Only an *absent* target is dropped; a malformed reference still fails the load, and `parseProject` still validates everything that remains. Older builds wrote the tiers of one save separately, so a tab closed mid-save could leave exactly this behind. The editor opens such a project with a notice, reports the drop through `reportError`, and writes the repaired state back so the next open is clean. A load that fails outright is reported too, with its issue codes and path shapes but never an issue's own text.

Reads report a permission denial as `not_found`, so the API never confirms the existence of a project the caller may not see. A listing the caller is not entitled to comes back empty rather than as an error.

## Favourite sounds

A producer's favourite sounds (LIB-011, #691) belong to the person, not to a project, so they live outside `projects/`, under the user: `users/{uid}/favourites/{favouriteId}`, one document per favourite. `src/persistence/favouriteDocuments.ts` owns that path and the document body, as `documents.ts` does for a project.

- **What a document holds.** A pack-qualified sound reference — the `pak_` pack ID and the sound's *library* asset ID (the manifest's ID, not a project's `ast_` ID) — plus `favouritedAt` (integer epoch milliseconds) and its own `schemaVersion` (`1`). Nothing else: no sound or pack name, no URL, no user-entered text. Names are read from the pack manifest when a favourite is shown.
- **One small document change.** The document ID is `{packId}~{URI-encoded assetId}`, derived from the reference, so adding is one `setDoc` and removing one `deleteDoc`, with no read first and no transaction. Favouriting a sound twice lands on the same document (refreshing `favouritedAt`); removing a non-favourite is a no-op.
- **Live across sessions.** `watchFavourites` is one collection listener, so a favourite added in one signed-in session reaches every other session of the same user.
- **Anonymous users.** An anonymous identity is a real uid that an account upgrade keeps, so a guest's favourites are still theirs after they register, exactly as their projects are.

`FavouritesRepository` (`src/persistence/favouritesRepository.ts`) mirrors `ProjectRepository`: `InMemoryFavouritesRepository` and `FirestoreFavouritesRepository` run one contract suite (`favouritesRepositoryContract.ts`, executed by `src/persistence/inMemoryFavouritesRepository.test.ts` and `tests/emulator/firestoreFavouritesRepository.emulator.test.ts`), and only the Firestore store imports `firebase/firestore`. A permission denial is reported as `not_allowed`. A stored document this build cannot read is left out of the list, as the dashboard does with a malformed project.

A favourite whose pack or sound the library no longer holds is not the repository's call — it stores references, not library facts. `resolveFavourites` (`src/library/favourites.ts`) resolves each one against the packs the library has loaded and reports it as missing (`pack_unavailable` or `asset_unavailable`) in its place in the list, rather than dropping it. `createFavouriteActions` in the same module is the one add/remove path a surface calls, and logs `library_favourite_changed` once per successful action (plus `feature_first_use` for `library_favourites` on the first add) without naming the sound or its pack. `getFavouritesRepository()` (`src/favouritesRepositoryClient.ts`) picks the in-memory or Firestore store the way `getProjectRepository()` does.

## Lesson records

Where a producer's lessons stand in a project (GRV-190) belongs to the producer, not to the project (a collaborator has lessons of their own), so it lives under the user: `users/{uid}/lessons/{projectId}`, one document per project. `src/persistence/lessonDocuments.ts` owns that path and the body:

- **`underWay`**: the lesson under way, or `null` once it ended or was left: its `lessonId`, `chapterIndex`, `biteId` and `stepIndex` (the bite's step count once the bite is over and waits on Next), how its bites have ended this time through (`endings`) and the bites its chapter passed over because the song already had them (`passed`).
- **`finished`**: every bite finished in the project, `{ how: "did_it" | "show_me" | "skipped", at }`. A position is never read from it; `src/lessons/session.ts`'s `startLesson` reads `underWay` alone.
- **`version`** (`1`) and **`updatedAt`** (integer epoch milliseconds).

IDs are checked by their shape, not against today's lessons, so an older build still reads a record that names a newer bite, and the lessons layer drops what it does not know. The profile's `lessonsDone` stays, derived: written as the union of the done bites (never skipped ones) whenever a bite finishes, and read only for the producer's progress across projects.

`LessonRepository` (`src/persistence/lessonRepository.ts`) mirrors `ProfileRepository`: one document read whole and written whole, `InMemoryLessonRepository` and `FirestoreLessonRepository` running one contract suite (`lessonRepositoryContract.ts`, executed by `src/persistence/inMemoryLessonRepository.test.ts` and `tests/emulator/firestoreLessonRepository.emulator.test.ts`), and `getLessonRepository()` (`src/lessonRepositoryClient.ts`) picking between them. The editor reads it once per account and project and writes it on every lesson transition (`src/editor/assistant/useLessonRecord.ts`), so a reload, another tab or another device brings the lesson back at the same step.

## Autosave

`ProjectAutosave` (`src/persistence/autosave.ts`) implements PRJ-03 and has no SolidJS dependency — it exposes a plain listener a provider can adapt into a signal.

- **Coalescing.** Edits are queued per entity (`song`, `clip:{id}`, `metadata`); a second edit to the same entity replaces the first, so a slider drag produces one write with the final value. A drain writes the whole queue as one `saveChanges` and one revision. Only a queue too large for one Firestore transaction (over 200 clip documents or about 4 MiB of them) is split, and then clip writes go first and clip deletions last, so every intermediate state still loads. The window defaults to 400 ms and uses an injectable `Scheduler` (`src/shared/scheduler.ts`) so tests drive it deterministically.
- **Save state.** `idle → pending → saving → saved`, or `failed` with the underlying failure. `flush()` writes everything immediately and is what a `pagehide` handler calls.
- **Retryable local state.** A failed write stays queued with its value and the drain stops there, so later writes do not burn revisions past a gap. `retry()` writes exactly what the user last saw.
- **Echo rejection.** A remote snapshot at or below the local revision is this client's own echo; one that arrives while a local edit is queued would overwrite state the user can still see. Both are ignored, and the caller is told which.

## Migrations

The current schema is **v6**. v1 was the first production schema; **v2 ([LIB-08](#packs-and-pack-qualified-assets)) added `metadata.addedPacks`, the pack shelf; v3 (LOOP-017) added `song.loop`, the loop range and loop toggle**; v4 (#290) made a track's placements disjoint; v5 (ARR-010) added `song.key`, the root and scale; v6 (#937) added `song.master.safetyLimiter`, whether the hidden master safety limiter runs. `src/persistence/migrations.ts` provides the mechanism and its rules:

- A **newer** schema version is never read and never overwritten — it is reported so the UI can ask the user to update.
- An **older** version is upgraded by applying every registered migration in order; a gap in the chain is an error, not a partial upgrade.
- **Every stored document is migrated from its own `schemaVersion`**, not the metadata's. A migration declares a per-document transform for each tier it changes (`metadata`, `song`, `clip`, `chunk`); a tier with none only moves its version envelope. Tiers are saved independently, so after the first save of a migrated project the tiers disagree on disk (a song edit rewrites song + metadata, a note edit one clip + metadata), and the next load must still open it.
- Migration is pure documents-to-documents, and the result still goes through `decodeProject`.

**Load-time application.** `decodeStoredProject` migrates a stored project forward and then decodes it, and both repositories' `loadProject` call it, so opening a project saved before a field was added never fails just because it predates the field. The dashboard reads only the metadata tier, so `decodeStoredProjectMetadata` applies the metadata half of each migration for `listProjects`/`loadProjectMetadata`/`watchProject`, and a pre-existing project still lists. Migration is read-time and pure: each tier persists at the new version the next time that tier is saved, not as a side effect of loading — which is why migration is per document.

**The v1 → v2 migration** bumps the `schemaVersion` envelope on every stored tier and seeds `addedPacks` from the packs the project already depends on (`metadata.packDependencies`, which v1 stored). A migrated v1 project therefore starts with exactly its used packs on the shelf — satisfying the "every used pack is shelved" invariant on the first read, before any `pack.add`/`pack.remove` runs.

**The v2 → v3 migration** bumps every tier's envelope the same way and gives the song document `loop: { startTicks: 0, endTicks: 768, enabled: true }` — one bar from tick 0, looping on, the same loop a new project starts with. The loop lives in the song document, so a loop edit is a song-tier write and never touches a clip document.

**The v3 → v4 migration** (#290) makes a track's placements disjoint in time, which `parseProject` now enforces as the `placement_overlap` invariant. For each overlapping pair on a track, the placement that starts earlier is kept intact and the overlapping part of the later one is trimmed away (its start moves to the earlier one's end and `clipOffsetTicks` advances by the same amount), or removed when it is fully covered; when two start on the same tick, the one earlier in the placements array is kept. The song document's placements and each arrangement chunk's are resolved independently, since a track's placements live in exactly one of them.

**The v4 → v5 migration** (ARR-010) gives the song document `key: { root: 0, scale: "chromatic" }`, the key every new project starts in, so a project saved before the key existed opens with nothing hidden or moved. A chromatic key's root is pinned to C by `checkSongIntegrity`. The key lives in the song document, so changing it is a song-tier write.

**The v5 → v6 migration** (#937) gives the song document's master `safetyLimiter: true`. Every project made before the Limiter device existed was mixed into the hidden safety limiter after the master volume, so it keeps it and sounds and exports exactly as it did. A new project is made with a visible Limiter on its master chain and `safetyLimiter: false` (`src/editor/composition/starterProject.ts`), so what limits its mix is on screen and can be bypassed or removed.

**Fixture convention.** Stored-state fixtures live at `public/fixtures/persistence/v{version}-{name}.json` and hold the `RawProjectDocuments` shape exactly as it was stored; load them with `loadStoredProjectFixture` from `src/testing/fixtures.ts`. `v6-slice-project.json` pins today's wire format — if encoding changes shape, that file stops decoding and the change has to become a deliberate migration. `v1-slice-project.json`, `v2-slice-project.json`, `v3-slice-project.json`, `v4-slice-project.json` and `v5-slice-project.json` are the source fixtures the v1 → v2, v2 → v3, v3 → v4, v4 → v5 and v5 → v6 migrations are tested against. `v7-future-project.json` is the unreadable-future-version case. Every migration added after v1 ships a fixture for each supported source version and tests that migrating it produces a valid project (PRJ-04).

## Security rules and indexes

`firestore.rules` enforces the layout: owner-or-collaborator access resolved from the metadata document, no ownership reassignment, no backwards revision, a `song` collection that only accepts `current`, clip and chunk documents whose ID matches their path, and a `projectId` that must match the path a document is written to. Structurally wrong writes — unknown schema version, missing revision, missing pack dependency list or shelf, unexpected metadata field — are rejected by the rules as well as by the decoder. Each child write costs one document read for the parent lookup, which is the price of not duplicating ownership onto every tier.

`users/{uid}/favourites/{favouriteId}` is readable and writable by `uid` alone. A write must carry exactly `schemaVersion` (`1`), a `pak_` `packId`, an `assetId` of 1–200 characters and an integer `favouritedAt`, under a document ID that starts with that pack ID.

`users/{uid}/lessons/{projectId}` is readable and writable by `uid` alone. A write must carry exactly `version` (`1`), `underWay` (`null` or a map of exactly its six fields), a `finished` map of at most 100 bites and an integer `updatedAt`.

Anonymous Firebase identities are ordinary identities here (PRJ-01): they own projects exactly like registered users, and upgrading an account keeps the same uid, so no rule distinguishes them.

`firestore.indexes.json` carries the dashboard's composite index (`ownerId` ascending, `modifiedAt` descending) and is wired into `firebase.json`.

Coverage lives in `tests/emulator/` (`bun run test:emulator`): `firestoreRules.emulator.test.ts` for owner, collaborator, anonymous, unauthenticated, deletion, malformed-write, and cross-project cases, and `firestoreProjectRepository.emulator.test.ts` for the repository contract against a real Firestore instance. The favourites rules are in the same rules file, and `firestoreFavouritesRepository.emulator.test.ts` runs the favourites contract through them.

## User data and the account allowance

Everything a user keeps that is not a project lives under `users/{uid}/` (#282). Personal packs are the first kind: a pack is one Firestore document at `users/{uid}/packs/{packId}` (its name, its version, and its sounds), and each sound's audio is one Cloud Storage object at `users/{uid}/packs/{packId}/{assetId}`. `src/userData/userData.ts` holds the layout, the kinds, and the limits; nothing else writes those paths down.

Every account gets **1 GB** across all of its user data, whatever the kind. The total lives in `users/{uid}/usage/current` (`totalBytes`, plus `byKind`), kept by two Storage-triggered Cloud Functions in `functions/src/index.ts` from Storage's own write and delete events. They are the repository's first server-side code: a thin wrapper over `src/userData/usageLedger.ts`, which keeps one ledger entry per object (`users/{uid}/usage/current/objects/{path}`) recording the generation it is about and whether it was counted, refused or deleted, so a repeated or out-of-order event never counts twice. A delete stays as a tombstone, so a write event delivered after its own delete is not counted for an object that is gone. A new kind of user data (recordings, presets) is a new folder and a new entry in `USER_DATA_KINDS`, and is counted with no change to the functions.

Enforcement is in two places:

- **`storage.rules`** refuse a write that would take the account over the allowance, by reading the usage document across services (`firestore.get`). They also require a registered account (not a guest), the owner's own folder, an accepted audio type, a non-empty file of at most 100 MB, and a fresh path — a stored sound is never overwritten. Reads are the owner's only. The total lags a write by the time the function takes, so two uploads started at once can each pass the rules. The ledger closes that gap: it counts writes one transaction at a time, and one that would take the total over 1 GB is recorded as `refused`, never counted, and deleted again by the function. The function also takes that sound out of the pack listing it, at the next major version, as its owner deleting it would (`src/userData/refusedSound.ts`), so no pack lists a sound with no audio behind it.
- **The client** reads the usage document before an import and warns from 90%, so a producer hears about the limit before a refused upload.

On the client, `src/userLibrary` is the personal library's side of this: `userPacks.ts` is the pack document's schema and how its version moves (a sound added is a minor version, a sound deleted a major one, so a project pinned to an earlier version still resolves every sound it uses and a deleted sound is reported missing by name), `UserLibraryRepository` is the boundary with an in-memory and a Firebase implementation running one contract suite, and `importSound.ts` imports a file in the order that never leaves a partial sound behind: refuse by type, size, allowance and decodability first, upload second, list it in the pack last, and delete the upload again if that last step fails or is cancelled. `firebaseUserLibraryRepository.ts` is the only module that touches Firestore or Storage for user data.

A stored sound has **no URL**, in its pack document or anywhere else. A Firebase download URL is a bearer token, and a personal sound inserted into a project travels with the project to every collaborator who can read it, and onto drags. So a pack names each sound by its `storagePath` alone, an inserted sound's project `Asset` carries that path as its `storageRef` with `url: null`, and the browser reads the bytes with `UserLibraryRepository.readAudio` (the Storage SDK's `getBytes`, as the signed-in user), which `storage.rules` allow to the owner only. The audio layer stays free of Firebase: `src/audio/storedAudio.ts` is a source the app installs once, and the buffer loader and the library's audition engine read any asset without a URL through it.

`firestore.rules` let only a registered owner write their packs, at most 500 sounds to a pack (its sounds are inline in the one document, which Firestore caps at 1 MiB), and nobody but the functions' admin credential write the usage document.

Deploying this needs the Blaze plan and Cloud Functions enabled (`bun run deploy` now deploys `functions` too; `firebase.json`'s `predeploy` bundles them with `bun build` and installs `functions/`'s own dependencies). The deploy credential needs the roles to deploy Cloud Functions (2nd gen) and their Eventarc Storage triggers, and the first deploy of rules that read Firestore from Storage grants the Storage service agent read access to Firestore. The functions run in `us-east1`, which has to match the default bucket's location.

Coverage: `src/userData/*.test.ts` for the layout, the limits (including that `storage.rules` repeats the same numbers) and the ledger, and `tests/emulator/userDataRules.emulator.test.ts` for both rule files against the emulators.
