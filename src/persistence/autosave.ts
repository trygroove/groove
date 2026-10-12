import type { Analytics } from "../analytics/analytics";
import { analytics as defaultAnalytics } from "../analytics/analytics";
import { toErrorCode } from "../analytics/errorCodes";
import type { Clip, ProjectMetadata, Song } from "../domain/entities";
import type { ClipId, ProjectId } from "../domain/ids";
import {
  type CancelScheduled,
  type Scheduler,
  timeoutScheduler,
} from "../shared/scheduler";
import { estimateDocumentBytes } from "./documentSize";
import { encodeClip } from "./documents";
import type {
  ProjectChangeSet,
  ProjectMetadataPatch,
  ProjectRepository,
  ProjectWatchEvent,
  SaveFailure,
} from "./projectRepository";

/**
 * Optimistic autosave (PRJ-03).
 *
 * Local state is authoritative while the user is editing. This controller sits
 * between the edited state and the repository and owns four behaviors:
 *
 * - **Coalescing.** Repeated edits to the same entity collapse to one queued
 *   write, so dragging a slider or typing a name produces a single document
 *   write with the final value rather than one per frame. Intermediate values
 *   are dropped; the final one never is, including when the edit lands while
 *   the previous write is still in flight.
 * - **Atomic drains.** Everything queued goes out as one `saveChanges`, so a
 *   tab closed mid-save leaves the store at the last whole state, never a song
 *   whose placements point at clips that were not written (#965).
 * - **Revision checks.** Every write states the revision it was made against;
 *   the repository refuses a stale one, so a slow tab cannot clobber newer state.
 * - **Retryable local state.** A failed write stays queued with its value, and
 *   the status carries the failure. `retry()` or the next edit tries again;
 *   nothing is silently dropped.
 * - **Echo rejection.** A remote snapshot at or below the local revision, or
 *   one that arrives while a local edit is still queued, is ignored rather than
 *   applied over newer local state.
 *
 * It has no SolidJS dependency: `subscribe` is a plain listener that a provider
 * can adapt into a signal.
 */

export type SaveState = "idle" | "pending" | "saving" | "saved" | "failed";

export interface SaveStatus {
  readonly state: SaveState;
  /** The revision the last acknowledged write produced. */
  readonly revision: number;
  /** Entities queued but not yet written. */
  readonly pending: number;
  readonly lastSavedAt: number | null;
  readonly failure: SaveFailure | null;
}

export type RemoteOutcome =
  | "adopted"
  | "ignored_stale"
  | "ignored_local_pending"
  | "removed"
  | "error";

export interface AutosaveOptions {
  repository: ProjectRepository;
  projectId: ProjectId;
  /** The revision the loaded project is at. */
  revision: number;
  /** How long rapid edits are collected before one write. */
  coalesceMs?: number;
  scheduler?: Scheduler;
  onStatus?: (status: SaveStatus) => void;
  /** Called when a remote snapshot is newer than local state and adopted. */
  onRemoteMetadata?: (metadata: ProjectMetadata) => void;
  /**
   * Analytics boundary for the PRD `OPS-02` `save_failed` reliability event.
   * Injectable so tests assert the event without touching global state.
   */
  analytics?: Analytics;
}

type PendingEntry =
  | { kind: "song"; song: Song }
  | { kind: "clip"; clip: Clip }
  | { kind: "clipDeletion"; clipId: ClipId }
  | { kind: "metadata"; patch: ProjectMetadataPatch };

type QueuedEntry = readonly [key: string, entry: PendingEntry];

const DEFAULT_COALESCE_MS = 400;

/**
 * How many clip documents one write may carry. A Firestore transaction takes
 * at most 500 writes and 10 MiB, and the song, its arrangement chunks, and the
 * metadata document share that with the clips; these leave room for them.
 */
const MAX_BATCH_CLIP_DOCUMENTS = 200;
const MAX_BATCH_CLIP_BYTES = 4 * 1024 * 1024;

/** The longest prefix of `writes` one transaction can carry, and never none. */
function withinBatchBudget(
  writes: readonly QueuedEntry[],
  projectId: ProjectId,
): QueuedEntry[] {
  const taken: QueuedEntry[] = [];
  let bytes = 0;
  for (const queued of writes) {
    const [, entry] = queued;
    if (entry.kind !== "clip") continue;
    const document = encodeClip(projectId, entry.clip, 0, 0);
    bytes += estimateDocumentBytes(document.path, document.data);
    const full = taken.length >= MAX_BATCH_CLIP_DOCUMENTS || bytes > MAX_BATCH_CLIP_BYTES;
    if (full && taken.length > 0) break;
    taken.push(queued);
  }
  return taken;
}

function toChangeSet(batch: readonly QueuedEntry[]): ProjectChangeSet {
  const clips: Clip[] = [];
  const deletedClipIds: ClipId[] = [];
  let song: Song | undefined;
  let metadata: ProjectMetadataPatch | undefined;
  for (const [, entry] of batch) {
    switch (entry.kind) {
      case "song":
        song = entry.song;
        break;
      case "clip":
        clips.push(entry.clip);
        break;
      case "clipDeletion":
        deletedClipIds.push(entry.clipId);
        break;
      case "metadata":
        metadata = entry.patch;
        break;
    }
  }
  return { song, clips, deletedClipIds, metadata };
}

export class ProjectAutosave {
  private readonly repository: ProjectRepository;
  private readonly projectId: ProjectId;
  private readonly coalesceMs: number;
  private readonly scheduler: Scheduler;
  private readonly listeners = new Set<(status: SaveStatus) => void>();
  private readonly onRemoteMetadata?: (metadata: ProjectMetadata) => void;
  private readonly analytics: Analytics;
  /**
   * Consecutive failed drains. Save success is a PRD section 11 release gate,
   * so `save_failed` reports how many attempts a write has already cost —
   * one failure that resolves on retry is a very different signal from a
   * write that keeps failing.
   */
  private consecutiveFailures = 0;
  /**
   * Keyed so a second edit to the same entity replaces the first. A drain
   * writes the whole queue as one change set (see `nextBatch`).
   */
  private readonly queue = new Map<string, PendingEntry>();

  private revision: number;
  private state: SaveState = "idle";
  private failure: SaveFailure | null = null;
  private lastSavedAt: number | null = null;
  private cancelScheduled: CancelScheduled | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(options: AutosaveOptions) {
    this.repository = options.repository;
    this.projectId = options.projectId;
    this.revision = options.revision;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.scheduler = options.scheduler ?? timeoutScheduler;
    this.onRemoteMetadata = options.onRemoteMetadata;
    this.analytics = options.analytics ?? defaultAnalytics;
    if (options.onStatus) {
      this.listeners.add(options.onStatus);
    }
  }

  get status(): SaveStatus {
    return {
      state: this.state,
      revision: this.revision,
      pending: this.queue.size,
      lastSavedAt: this.lastSavedAt,
      failure: this.failure,
    };
  }

  subscribe(listener: (status: SaveStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  queueSong(song: Song): void {
    this.enqueue("song", { kind: "song", song });
  }

  queueClip(clip: Clip): void {
    this.enqueue(`clip:${clip.id}`, { kind: "clip", clip });
  }

  queueClipDeletion(clipId: ClipId): void {
    this.enqueue(`clip:${clipId}`, { kind: "clipDeletion", clipId });
  }

  queueMetadata(patch: ProjectMetadataPatch): void {
    const existing = this.queue.get("metadata");
    const merged =
      existing?.kind === "metadata" ? { ...existing.patch, ...patch } : patch;
    this.enqueue("metadata", { kind: "metadata", patch: merged });
  }

  /**
   * Writes everything queued right now. Call it from a `pagehide`/`beforeunload`
   * handler so the final value survives navigation where the browser allows it.
   */
  async flush(): Promise<SaveStatus> {
    this.cancelPending();
    // `while`, not `if`. Several callers can park here at once — every edit
    // re-arms the coalescing timer and each firing calls flush — and they all
    // wake when the drain they were waiting on settles. If each then started
    // its own drain, two loops would write the same entry at the same base
    // revision: one wins, the other comes back `revision_conflict` against
    // this controller's own write, leaving an unclearable "save failed" over a
    // project that is fully saved.
    //
    // Re-testing closes that. The first caller to wake exits the loop and
    // assigns `inFlight` with no await in between, so by the time any other
    // caller resumes the handle is already set and it joins that drain rather
    // than starting a second one.
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.queue.size > 0 && !this.disposed) {
      const drain = this.drain();
      this.inFlight = drain;
      try {
        await drain;
      } finally {
        // Only ever clear the handle this call owns. Clearing unconditionally
        // would let the next caller past the guard while a drain it did not
        // start was still running.
        if (this.inFlight === drain) {
          this.inFlight = null;
        }
      }
    }
    return this.status;
  }

  /** Retries after a failure, keeping the queued values. */
  async retry(): Promise<SaveStatus> {
    return this.flush();
  }

  /**
   * Applies a remote snapshot, or explains why it was ignored. A snapshot at or
   * below the local revision is this client's own echo; one that arrives while
   * a local edit is queued would overwrite an edit the user can still see.
   */
  applyRemote(event: ProjectWatchEvent): RemoteOutcome {
    if (event.kind === "removed") {
      return "removed";
    }
    if (event.kind === "error") {
      return "error";
    }
    if (event.metadata.revision <= this.revision) {
      return "ignored_stale";
    }
    if (this.queue.size > 0 || this.state === "saving") {
      return "ignored_local_pending";
    }
    this.revision = event.metadata.revision;
    this.onRemoteMetadata?.(event.metadata);
    this.publish();
    return "adopted";
  }

  /**
   * Drops everything queued and makes `revision` the base of the next write
   * (GRV-88). The caller has loaded that revision as it was saved elsewhere,
   * replayed its own unsaved edits on top, and re-queues what they changed, so
   * the edits are written over the other tab's change rather than refused as a
   * conflict at the old base. Only legal while no write is in flight: that
   * write's outcome is what says whether a newer revision is someone else's.
   */
  rebase(revision: number): void {
    if (this.state === "saving") {
      throw new Error("Cannot rebase the autosave while a write is in flight");
    }
    this.cancelPending();
    this.queue.clear();
    this.revision = revision;
    this.failure = null;
    this.consecutiveFailures = 0;
    this.state = "saved";
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.listeners.clear();
  }

  private enqueue(key: string, entry: PendingEntry): void {
    if (this.disposed) return;
    this.queue.set(key, entry);
    this.state = "pending";
    this.publish();
    this.schedule();
  }

  private schedule(): void {
    this.cancelPending();
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = null;
      void this.flush();
    }, this.coalesceMs);
  }

  private cancelPending(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private async drain(): Promise<void> {
    this.state = "saving";
    this.failure = null;
    this.publish();

    // Captured before the loop can reset it: a drain that starts having
    // already failed at least once is a retry of a failure episode, and
    // `save_recovered` (below) reports how many attempts that episode cost —
    // one event per episode, not one per attempt, matching `save_failed`.
    const retryCountIfRecovered = this.consecutiveFailures;

    while (this.queue.size > 0 && !this.disposed) {
      const batch = this.nextBatch();
      const result = await this.repository.saveChanges(
        this.projectId,
        toChangeSet(batch),
        this.revision,
      );
      if (!result.ok) {
        // The entry stays queued with its value so a retry — or the browser
        // coming back online — can write exactly what the user last saw.
        this.failure = result;
        this.state = "failed";
        // PRD `OPS-02`: the reliability event for this task's principal
        // failure path. `reason` is already a stable, enumerated code, so
        // nothing derived from the failure *message* is logged.
        this.analytics.log("save_failed", {
          error_code: toErrorCode(result.reason),
          retry_count: this.consecutiveFailures,
        });
        this.consecutiveFailures += 1;
        this.publish();
        return;
      }
      // Compare-and-delete: an edit to the same entity made *during* the await
      // replaced the slot, and that newer value has not been written. Dropping
      // it here would lose the user's final value while reporting "saved", so
      // only the entry that was actually written is dequeued; a replacement
      // stays queued and the loop writes it at the new revision.
      for (const [key, entry] of batch) {
        if (this.queue.get(key) === entry) {
          this.queue.delete(key);
        }
      }
      this.revision = result.revision;
      this.lastSavedAt = result.modifiedAt;
    }

    if (!this.disposed) {
      // A clean drain ends the failure streak. `save_recovered` fires only
      // when this drain actually recovered one — an ordinary drain with no
      // prior failure is not a "recovery" and stays silent.
      if (retryCountIfRecovered > 0) {
        this.analytics.log("save_recovered", {
          retry_count: retryCountIfRecovered,
        });
      }
      this.consecutiveFailures = 0;
      this.state = "saved";
      this.publish();
    }
  }

  /**
   * What the next write carries: normally everything queued, as one atomic
   * `saveChanges`, so the store never holds a song whose placements point at
   * clips that were not written, or a clip whose track was removed (#965).
   *
   * Only a queue too large for one backend transaction is split, and then in
   * the order that keeps every intermediate state loadable: clip writes go
   * ahead of the song that places them (an unplaced clip is harmless), and
   * clip deletions follow it (an unplaced clip again).
   */
  private nextBatch(): QueuedEntry[] {
    const entries = [...this.queue.entries()];
    const clipWrites = entries.filter(([, entry]) => entry.kind === "clip");
    const leading = withinBatchBudget(clipWrites, this.projectId);
    if (leading.length < clipWrites.length) {
      return leading;
    }
    const deletions = entries.filter(([, entry]) => entry.kind === "clipDeletion");
    return [
      ...entries.filter(([, entry]) => entry.kind !== "clipDeletion"),
      ...deletions.slice(0, MAX_BATCH_CLIP_DOCUMENTS),
    ];
  }

  private publish(): void {
    const status = this.status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

export function createProjectAutosave(options: AutosaveOptions): ProjectAutosave {
  return new ProjectAutosave(options);
}
