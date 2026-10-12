import {
  collection,
  deleteDoc,
  doc,
  type Firestore,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  type Transaction,
  where,
  writeBatch,
} from "firebase/firestore";
import type { Clip, Project, ProjectMetadata, Song } from "../domain/entities";
import type { ClipId, ProjectId } from "../domain/ids";
import type { JsonObject } from "../domain/serialize";
import { type Clock, systemClock } from "../shared/clock";
import {
  ARRANGEMENT_COLLECTION,
  arrangementChunkPath,
  CLIPS_COLLECTION,
  clipDocumentPath,
  clipsCollectionPath,
  encodeProject,
  encodeProjectMetadata,
  findOversizedDocuments,
  PROJECTS_COLLECTION,
  projectDocumentPath,
  SONG_COLLECTION,
  SONG_DOCUMENT_ID,
  type StoredDocument,
  songDocumentPath,
} from "./documents";
import {
  changeSetDerivedFields,
  encodeChangeSet,
  nextMetadata,
  revisionConflict,
  toMetadataResult,
  tooLarge,
} from "./inMemoryProjectRepository";
import { decodeStoredProject } from "./migrations";
import {
  type DerivedMetadataFields,
  type LoadResult,
  loadFailure,
  type ProjectChangeSet,
  type ProjectMetadataPatch,
  type ProjectRepository,
  type ProjectWatchEvent,
  type SaveResult,
  saveFailure,
  type Unsubscribe,
} from "./projectRepository";

/**
 * The Firestore repository.
 *
 * Every revision-checked write runs inside a Firestore transaction: the
 * metadata document is read, the caller's base revision is compared against it,
 * and the tier document plus the revision bump are committed together or not at
 * all. That is what makes a stale write from a slow tab or a re-delivered
 * offline mutation fail loudly instead of overwriting newer state.
 *
 * A `Firestore` instance is injected rather than imported from
 * `firebaseConfig`, so the emulator suite points the identical code at a local
 * emulator and the contract tests apply to the real backend.
 */
export class FirestoreProjectRepository implements ProjectRepository {
  private readonly db: Firestore;
  private readonly clock: Clock;

  constructor(db: Firestore, options: { clock?: Clock } = {}) {
    this.db = db;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Creates a project in two steps, because the security rules resolve a child
   * document's owner from its parent and rule `get()`s see the database as it
   * was before the write commits. The metadata document is therefore claimed
   * first; only then can the song, clip, and chunk documents be authorized. If
   * the second step fails, the claimed metadata document is removed rather
   * than left behind as a project with no song. That second step is a plain
   * batch Firestore resends if its acknowledgement is lost; the rules let a
   * resend that rewrites what the first send stored through (#891).
   */
  async createProject(project: Project): Promise<SaveResult> {
    const documents = encodeProject(project);
    const oversized = findOversizedDocuments(documents);
    if (oversized.length > 0) {
      return tooLarge(oversized);
    }
    // `runTransaction` re-runs this function when a commit fails with a
    // retryable code such as `unavailable`, and a commit can reach the server
    // even though its acknowledgement never comes back. Once an attempt has
    // written the metadata document, finding it on a later attempt means that
    // write landed: the ID is this call's own claim, not someone else's (#891).
    let claimed = false;
    try {
      await runTransaction(this.db, async (tx) => {
        const metadataRef = this.ref(documents.metadata.path);
        const existing = await tx.get(metadataRef);
        if (existing.exists() && claimed) {
          return;
        }
        if (existing.exists()) {
          throw new AbortWrite(
            saveFailure(
              "already_exists",
              `Project ${project.metadata.id} already exists`,
            ),
          );
        }
        this.write(tx, documents.metadata);
        claimed = true;
      });
    } catch (error) {
      return toSaveFailure(error);
    }
    try {
      await this.commitAll([
        documents.song,
        ...documents.clips,
        ...documents.arrangement,
      ]);
    } catch (error) {
      await deleteDoc(this.ref(documents.metadata.path)).catch(() => {});
      return toSaveFailure(error);
    }
    return {
      ok: true,
      revision: project.metadata.revision,
      modifiedAt: project.metadata.modifiedAt,
    };
  }

  /** Commits documents in batches, staying under Firestore's 500-write limit. */
  private async commitAll(documents: readonly StoredDocument[]): Promise<void> {
    for (let index = 0; index < documents.length; index += BATCH_SIZE) {
      const batch = writeBatch(this.db);
      for (const document of documents.slice(index, index + BATCH_SIZE)) {
        batch.set(this.ref(document.path), document.data);
      }
      await batch.commit();
    }
  }

  async loadProject(projectId: ProjectId): Promise<LoadResult<Project>> {
    try {
      const metadata = await this.readDocument(projectDocumentPath(projectId));
      if (!metadata) {
        return loadFailure("not_found", `Project ${projectId} does not exist`);
      }
      const [song, clips, arrangement] = await Promise.all([
        this.readDocument(songDocumentPath(projectId)),
        this.readCollection(clipsCollectionPath(projectId)),
        this.readCollection(
          `${projectDocumentPath(projectId)}/${ARRANGEMENT_COLLECTION}`,
        ),
      ]);
      const decoded = decodeStoredProject({
        projectId,
        metadata,
        song,
        clips,
        arrangement,
      });
      if (decoded.ok) {
        return decoded.dropped
          ? { ok: true, value: decoded.value, dropped: decoded.dropped }
          : { ok: true, value: decoded.value };
      }
      return loadFailure(
        decoded.issues.some((issue) => issue.code === "unsupported_schema_version")
          ? "unsupported_schema_version"
          : "invalid_document",
        `Stored project ${projectId} could not be read as a current-schema project`,
        decoded.issues,
      );
    } catch (error) {
      return toLoadFailure(error, projectId);
    }
  }

  async loadProjectMetadata(projectId: ProjectId): Promise<LoadResult<ProjectMetadata>> {
    try {
      const raw = await this.readDocument(projectDocumentPath(projectId));
      if (!raw) {
        return loadFailure("not_found", `Project ${projectId} does not exist`);
      }
      return toMetadataResult(projectId, raw);
    } catch (error) {
      return toLoadFailure(error, projectId);
    }
  }

  /**
   * The dashboard query. It reads the metadata collection only — never the
   * `song` or `clips` subcollections — so listing is independent of project
   * size. `firestore.indexes.json` carries the composite index it needs.
   */
  async listProjects(ownerId: string): Promise<ProjectMetadata[]> {
    let snapshot: Awaited<ReturnType<typeof getDocs>>;
    try {
      snapshot = await getDocs(
        query(
          collection(this.db, PROJECTS_COLLECTION),
          where("ownerId", "==", ownerId),
          orderBy("modifiedAt", "desc"),
        ),
      );
    } catch (error) {
      // The rules reject a listing the caller is not entitled to rather than
      // filtering it, so asking for another user's projects is an empty list,
      // not an error the dashboard has to render.
      if (firestoreErrorCode(error) === "permission-denied") {
        return [];
      }
      throw error;
    }
    const summaries: ProjectMetadata[] = [];
    for (const document of snapshot.docs) {
      const decoded = toMetadataResult(document.id, document.data() as JsonObject);
      // A document the current build cannot parse is skipped rather than
      // allowed to break the whole listing.
      if (decoded.ok) {
        summaries.push(decoded.value);
      }
    }
    return summaries;
  }

  async saveMetadata(
    projectId: ProjectId,
    patch: ProjectMetadataPatch,
    baseRevision: number,
  ): Promise<SaveResult> {
    return this.saveChanges(projectId, { metadata: patch }, baseRevision);
  }

  async saveSong(
    projectId: ProjectId,
    song: Song,
    baseRevision: number,
  ): Promise<SaveResult> {
    return this.saveChanges(projectId, { song }, baseRevision);
  }

  async saveClip(
    projectId: ProjectId,
    clip: Clip,
    baseRevision: number,
  ): Promise<SaveResult> {
    return this.saveChanges(projectId, { clips: [clip] }, baseRevision);
  }

  async deleteClip(
    projectId: ProjectId,
    clipId: ClipId,
    baseRevision: number,
  ): Promise<SaveResult> {
    return this.saveChanges(projectId, { deletedClipIds: [clipId] }, baseRevision);
  }

  /**
   * One Firestore transaction for the whole set: the clip documents, the song
   * and its chunks, the clip deletions, and the metadata revision bump commit
   * together or not at all (#965).
   */
  async saveChanges(
    projectId: ProjectId,
    changes: ProjectChangeSet,
    baseRevision: number,
  ): Promise<SaveResult> {
    return this.withRevisionCheck(
      projectId,
      baseRevision,
      async (tx, _metadata, next) => {
        const encoded = encodeChangeSet(projectId, changes, next);
        if (!encoded.ok) {
          throw new AbortWrite(encoded.failure);
        }
        // A transaction does every read before its first write. The previous
        // song document lists the chunks it wrote, so stale chunks are removed
        // without a query inside the transaction.
        const previousChunks = encoded.song
          ? await this.previousChunkTrackIds(tx, projectId)
          : [];
        for (const clip of encoded.clips) {
          this.write(tx, clip);
        }
        if (encoded.song) {
          const keep = new Set(encoded.song.arrangement.map((chunk) => chunk.path));
          for (const trackId of previousChunks) {
            const path = arrangementChunkPath(projectId, trackId);
            if (!keep.has(path)) {
              tx.delete(this.ref(path));
            }
          }
          this.write(tx, encoded.song.song);
          for (const chunk of encoded.song.arrangement) {
            this.write(tx, chunk);
          }
        }
        for (const clipId of changes.deletedClipIds ?? []) {
          tx.delete(this.ref(clipDocumentPath(projectId, clipId)));
        }
      },
      changes.metadata,
      changeSetDerivedFields(changes),
    );
  }

  private async previousChunkTrackIds(
    tx: Transaction,
    projectId: ProjectId,
  ): Promise<string[]> {
    const previous = await tx.get(this.ref(songDocumentPath(projectId)));
    return previous.exists()
      ? ((previous.data().chunkTrackIds as string[] | undefined) ?? [])
      : [];
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const paths = [
      ...(await this.collectionPaths(clipsCollectionPath(projectId))),
      ...(await this.collectionPaths(
        `${projectDocumentPath(projectId)}/${ARRANGEMENT_COLLECTION}`,
      )),
      songDocumentPath(projectId),
      projectDocumentPath(projectId),
    ];
    // Firestore caps a batch at 500 writes, so a project with many chunks and
    // clips is deleted in batches rather than one oversized commit. The
    // metadata document is last: the rules resolve a child's owner from it.
    for (let index = 0; index < paths.length; index += BATCH_SIZE) {
      const batch = writeBatch(this.db);
      for (const path of paths.slice(index, index + BATCH_SIZE)) {
        batch.delete(this.ref(path));
      }
      await batch.commit();
    }
  }

  watchProject(
    projectId: ProjectId,
    listener: (event: ProjectWatchEvent) => void,
  ): Unsubscribe {
    return onSnapshot(
      this.ref(projectDocumentPath(projectId)),
      (snapshot) => {
        if (!snapshot.exists()) {
          listener({ kind: "removed" });
          return;
        }
        const decoded = toMetadataResult(projectId, snapshot.data() as JsonObject);
        listener(
          decoded.ok
            ? { kind: "metadata", metadata: decoded.value }
            : { kind: "error", message: decoded.message },
        );
      },
      (error) => listener({ kind: "error", message: error.message }),
    );
  }

  // --- internals ------------------------------------------------------

  private async withRevisionCheck(
    projectId: ProjectId,
    baseRevision: number,
    mutate: (
      tx: Transaction,
      metadata: ProjectMetadata,
      next: WriteStamp,
    ) => Promise<void>,
    patch: ProjectMetadataPatch = {},
    derived: DerivedMetadataFields = {},
  ): Promise<SaveResult> {
    // The stamp the last attempt wrote. `runTransaction` re-runs this function
    // when a commit fails with a retryable code, and a commit can land even
    // though its acknowledgement is lost. A retry that finds exactly that
    // revision and timestamp stored is reading its own write, not a conflict.
    let attempted: WriteStamp | undefined;
    try {
      const outcome = await runTransaction<WriteStamp>(this.db, async (tx) => {
        const metadataRef = this.ref(projectDocumentPath(projectId));
        const snapshot = await tx.get(metadataRef);
        if (!snapshot.exists()) {
          throw new AbortWrite(
            saveFailure("not_found", `Project ${projectId} does not exist`),
          );
        }
        const decoded = toMetadataResult(projectId, snapshot.data() as JsonObject);
        if (!decoded.ok) {
          throw new AbortWrite(
            saveFailure(
              decoded.reason === "unsupported_schema_version"
                ? "unsupported_schema_version"
                : "invalid_document",
              decoded.message,
              { issues: decoded.issues },
            ),
          );
        }
        const metadata = decoded.value;
        if (
          attempted &&
          metadata.revision === attempted.revision &&
          metadata.modifiedAt === attempted.modifiedAt
        ) {
          return attempted;
        }
        if (metadata.revision !== baseRevision) {
          throw new AbortWrite(revisionConflict(baseRevision, metadata.revision));
        }
        const next: WriteStamp = {
          revision: metadata.revision + 1,
          modifiedAt: this.clock.now(),
        };
        await mutate(tx, metadata, next);
        this.write(
          tx,
          encodeProjectMetadata(
            nextMetadata(metadata, patch, derived, next.revision, next.modifiedAt),
          ),
        );
        attempted = next;
        return next;
      });
      return { ok: true, ...outcome };
    } catch (error) {
      if (firestoreErrorCode(error) === "permission-denied") {
        const conflict = await this.conflictBehindRefusal(projectId, baseRevision);
        if (conflict) return conflict;
      }
      return toSaveFailure(error);
    }
  }

  /**
   * The security rules refuse a save that does not move the stored revision
   * on by exactly one (GRV-7). When another tab's save lands between this
   * transaction's read and its commit, the Firestore emulator evaluates the
   * rules before the transaction's read preconditions, so the commit comes
   * back `permission-denied` rather than as the retryable contention error the
   * SDK would re-run the transaction for. Production may check the
   * preconditions first and return `aborted` instead, in which case the SDK
   * re-runs the transaction and its fresh read finds the conflict as before.
   * This handles the emulator's order: reading the revision again tells a
   * refusal behind a moved revision apart from any other, and the caller gets
   * the same conflict a re-run would have found.
   */
  private async conflictBehindRefusal(
    projectId: ProjectId,
    baseRevision: number,
  ): Promise<SaveResult | null> {
    try {
      const raw = await this.readDocument(projectDocumentPath(projectId));
      if (!raw) return null;
      const decoded = toMetadataResult(projectId, raw);
      if (!decoded.ok || decoded.value.revision === baseRevision) return null;
      return revisionConflict(baseRevision, decoded.value.revision);
    } catch {
      return null;
    }
  }

  private write(tx: Transaction, document: StoredDocument): void {
    tx.set(this.ref(document.path), document.data);
  }

  private ref(path: string) {
    const segments = path.split("/");
    return doc(this.db, segments[0], ...segments.slice(1));
  }

  private async readDocument(path: string): Promise<JsonObject | undefined> {
    const snapshot = await getDoc(this.ref(path));
    return snapshot.exists() ? (snapshot.data() as JsonObject) : undefined;
  }

  private async readCollection(path: string): Promise<JsonObject[]> {
    const snapshot = await getDocs(collection(this.db, path));
    return snapshot.docs.map((document) => document.data() as JsonObject);
  }

  private async collectionPaths(path: string): Promise<string[]> {
    const snapshot = await getDocs(collection(this.db, path));
    return snapshot.docs.map((document) => `${path}/${document.id}`);
  }
}

/** Firestore caps a batch at 500 writes; leave headroom under it. */
const BATCH_SIZE = 400;

/** The revision and modified time one write stamps across the tiers it touches. */
interface WriteStamp {
  readonly revision: number;
  readonly modifiedAt: number;
}

/** Carries a typed failure out of a Firestore transaction callback. */
class AbortWrite extends Error {
  readonly result: SaveResult;

  constructor(result: SaveResult) {
    super(result.ok ? "aborted" : result.message);
    this.name = "AbortWrite";
    this.result = result;
  }
}

function toSaveFailure(error: unknown): SaveResult {
  if (error instanceof AbortWrite) {
    return error.result;
  }
  const code = firestoreErrorCode(error);
  if (code === "permission-denied") {
    return saveFailure(
      "unavailable",
      "The current user is not allowed to write this project",
      { retryable: false },
    );
  }
  return saveFailure("unavailable", messageOf(error));
}

function toLoadFailure<T>(error: unknown, projectId: string): LoadResult<T> {
  // Permission-denied is reported as not-found on read so the API never
  // confirms the existence of a project the caller may not see.
  return firestoreErrorCode(error) === "permission-denied"
    ? loadFailure("not_found", `Project ${projectId} does not exist`)
    : loadFailure("unavailable", messageOf(error));
}

function firestoreErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFirestoreProjectRepository(
  db: Firestore,
  options: { clock?: Clock } = {},
): FirestoreProjectRepository {
  return new FirestoreProjectRepository(db, options);
}

export const FIRESTORE_COLLECTIONS = {
  projects: PROJECTS_COLLECTION,
  song: SONG_COLLECTION,
  songDocument: SONG_DOCUMENT_ID,
  clips: CLIPS_COLLECTION,
  arrangement: ARRANGEMENT_COLLECTION,
} as const;
