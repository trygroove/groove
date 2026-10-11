// Framework-free wiring for one open project: CommandHistory, ProjectAutosave
// and the repository watch. `useEditorSession` is its Solid adapter.

import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { bucketOf, projectAgeBucket } from "../analytics/buckets";
import { COMMAND_IDS, type CommandId } from "../analytics/catalog";
import {
  type CommandActor,
  CommandHistory,
  executeTransaction,
  type Gesture,
  type GestureOptions,
  type HistorySnapshot,
  type RawCommandInput,
  type TransactionFailure,
  type TransactionOptions,
  type TransactionResult,
  type TransactionSuccess,
} from "../commands";
import type { Clip, Project } from "../domain/entities";
import type { ClipId } from "../domain/ids";
import { createProjectAutosave, type ProjectAutosave } from "../persistence/autosave";
import type { DroppedReferences } from "../persistence/documents";
import type { ProjectRepository } from "../persistence/projectRepository";
import { type Clock, systemClock } from "../shared/clock";
import type { Scheduler } from "../shared/scheduler";
import { markProjectOpened } from "./deviceProjectRecord";
import {
  type PreviewEndReason,
  type PreviewHost,
  type PreviewResult,
  type PreviewStatus,
  SessionPreview,
} from "./sessionPreview";

export type {
  Preview,
  PreviewEndReason,
  PreviewResult,
  PreviewStatus,
} from "./sessionPreview";

/**
 * The history's snapshot, seen through any open preview: `project` is what the
 * editor shows (the previewed project while a preview is open), and
 * `committedProject` is what history, revision and autosave hold.
 */
export interface EditorSessionSnapshot extends HistorySnapshot {
  readonly committedProject: Project;
  readonly previewing: boolean;
}

export type EditorSessionListener = (snapshot: EditorSessionSnapshot) => void;

/**
 * One change this session committed to the project: a dispatch, a finished
 * gesture, an undo or a redo. Never a remote change, and never a preview
 * opening or ending, since neither is an edit made here.
 */
export interface SessionEdit {
  readonly kind: "edit" | "undo" | "redo";
  /** Who authored the history entry (for an undo or redo, the undone entry's author). */
  readonly actor: CommandActor;
  /** The history entry's correlation ID: the one an undo or a redo replays. */
  readonly correlationId: string;
  /** What was committed, as the entry records it (for an undo, the entry undone). */
  readonly commands: readonly RawCommandInput[];
  /** The committed project just before the change. */
  readonly before: Project;
}

export type SessionEditListener = (edit: SessionEdit) => void;

export interface EditorSessionOptions {
  readonly repository: ProjectRepository;
  /** The project as it was loaded (or just created). */
  readonly project: Project;
  readonly clock?: Clock;
  readonly analytics?: Analytics;
  /** Forwarded to `ProjectAutosave`; tests inject a manual scheduler. */
  readonly scheduler?: Scheduler;
  readonly coalesceMs?: number;
  /**
   * Where the `project_opened` first-open marker is recorded (PRD `OPS-02`).
   * Tests inject an isolated store; defaults to `localStorage`.
   */
  readonly deviceStorage?: Storage | null;
  /**
   * What loading dropped because it referenced documents that were never
   * stored (#965). The session writes the repaired state back, so the store
   * heals and the next open is clean.
   */
  readonly dropped?: DroppedReferences;
}

function isCommandId(value: string): value is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(value);
}

/**
 * Combines the shared command/undo kernel with autosave and the repository's
 * remote watch for one open project (`FND-009`'s UI-to-command-to-audio-to-
 * persistence path).
 *
 * A dispatched command (or an undo/redo) applies through `CommandHistory` —
 * one revision, one history entry, deterministic inverse — and, for the note
 * commands this slice's step grid uses, queues exactly the clip document that
 * changed through `ProjectAutosave`. `ProjectAutosave.applyRemote` already
 * guarantees a stale or older remote echo can never move local state
 * backward (see `src/persistence/autosave.ts`); this class only wires the
 * repository's watch into it.
 *
 * Framework-free, like `CommandHistory` and `ProjectAutosave` themselves —
 * `src/editor/useEditorSession.ts` is what adapts it into Solid signals.
 *
 * Autosave scope is a structural diff of the committed project against the one
 * before it (see {@link queueAutosave}): a changed `song` reference queues the
 * song tier, and each clip that was added, edited, or removed queues that clip
 * document. `LOOP-007` introduced the first UI that edits song structure
 * (tracks and the mixer), so dispatch-to-autosave had to cover the song tier
 * and multi-clip track edits, not just the single clip a note command names.
 * The same diff drives `beginGesture`'s commit path, so a piano-roll note drag
 * and a fader/pan drag share exactly one autosave mechanism.
 *
 * `beginPreview` (UI-005, #851) shows a set of commands applied without
 * committing them; see its own comment for the rules.
 */
export class EditorSession {
  readonly repository: ProjectRepository;
  readonly history: CommandHistory;
  readonly autosave: ProjectAutosave;
  private readonly analytics: Analytics;
  private readonly clock: Clock;
  private readonly projectId: Project["metadata"]["id"];
  private readonly openedAt: number;
  private readonly unwatch: () => void;
  private readonly listeners = new Set<EditorSessionListener>();
  private readonly editListeners = new Set<SessionEditListener>();
  private readonly remoteListeners = new Set<() => void>();
  private readonly unsubscribeHistory: () => void;
  private readonly previewHost: PreviewHost = {
    cancelPreview: (preview) => this.endPreview(preview, "cancelled", "cancelled"),
    commitPreview: (preview, actor) => this.commitPreview(preview, actor),
  };
  private preview: SessionPreview | null = null;
  private firstEditLogged = false;
  private disposed = false;

  constructor(options: EditorSessionOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? systemClock;
    this.analytics = options.analytics ?? defaultAnalytics;
    this.projectId = options.project.metadata.id;
    this.openedAt = this.clock.now();
    this.history = new CommandHistory(options.project, { clock: this.clock });
    this.autosave = createProjectAutosave({
      repository: options.repository,
      projectId: this.projectId,
      revision: options.project.metadata.revision,
      analytics: this.analytics,
      scheduler: options.scheduler,
      coalesceMs: options.coalesceMs,
    });
    this.unsubscribeHistory = this.history.subscribe(() => this.onHistoryChange());
    this.unwatch = options.repository.watchProject(this.projectId, (event) => {
      // A remote change moves the committed revision under an open preview,
      // so the preview is stale. An echo or an ignored snapshot moves nothing.
      if (this.autosave.applyRemote(event) === "adopted") {
        this.endOpenPreview("stale", "remote_change");
        for (const listener of [...this.remoteListeners]) listener();
      }
    });
    this.logProjectOpened(options.project, options.deviceStorage);
    if (options.dropped) {
      this.queueRepair(options.project, options.dropped);
    }
  }

  /** What the editor shows: the previewed project while a preview is open. */
  get project(): Project {
    return this.preview?.project ?? this.history.project;
  }

  /** What history, revision and autosave hold, whatever is being previewed. */
  get committedProject(): Project {
    return this.history.project;
  }

  /** The open preview, if there is one. */
  get activePreview(): SessionPreview | null {
    return this.preview;
  }

  snapshot(): EditorSessionSnapshot {
    const history = this.history.snapshot();
    return {
      ...history,
      project: this.project,
      committedProject: history.project,
      previewing: this.preview !== null,
    };
  }

  /**
   * Notified on every history change and whenever a preview opens or ends,
   * with the project the editor should show.
   */
  subscribe(listener: EditorSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notified after every change this session commits (see {@link SessionEdit}),
   * once the snapshot listeners have heard about it. The assistant uses it to
   * tell a producer's own edit to what it changed apart from anything else
   * (GRV-5).
   */
  subscribeEdits(listener: SessionEditListener): () => void {
    this.editListeners.add(listener);
    return () => {
      this.editListeners.delete(listener);
    };
  }

  /**
   * Notified whenever a change made elsewhere (another tab, another device)
   * is adopted, moving the saved revision under this session. Anything worked
   * out against the revision before it, a proposal included, is out of date.
   */
  subscribeRemoteChanges(listener: () => void): () => void {
    this.remoteListeners.add(listener);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  /**
   * Dispatches one command, or an atomic multi-command transaction. While a
   * preview is open the edit goes to the committed project, and that makes
   * the preview stale; it is never edited into the preview.
   *
   * `options` is for a caller that commits on someone else's behalf: the
   * assistant's proposal executor (GRV-4) names its actor, its correlation ID
   * and the revision the proposal was validated against.
   */
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
    options: TransactionOptions = {},
  ): TransactionResult {
    return this.execute(commands, options);
  }

  /** True while a continuous gesture is open on the history. */
  get gestureActive(): boolean {
    return this.history.gestureActive;
  }

  /** The newest undo entry's correlation ID, or null with nothing to undo. */
  get latestCorrelationId(): string | null {
    const { entries } = this.history;
    return entries[entries.length - 1]?.correlationId ?? null;
  }

  /**
   * Shows `commands` applied without committing them (UI-005, #851).
   *
   * The commands run through `executeTransaction` against the committed
   * project. If they are invalid, this returns the same failure a dispatch
   * would and nothing changes, an already-open preview included. If they are
   * valid, the editor's project becomes the previewed one, so every view, the
   * audio graph and the projections show and play the change, while the
   * committed project, its revision, the history and autosave are untouched
   * and nothing is written.
   *
   * One preview is open at a time: a valid new one cancels the previous one
   * (`superseded`). The preview ends on `cancel()`, on `commit(actor)` (one
   * transaction, one history entry, one revision), or by going stale when the
   * committed revision moves under it — a local edit, a remote change, an
   * undo or a redo.
   *
   * It is refused (a `rejected` failure, nothing changes) while a gesture is
   * open, since the committed project is mid-drag, and once the session is
   * disposed. A gesture opened *after* the preview does not end it, but
   * `commit` refuses until that gesture finishes: see {@link commitPreview}.
   */
  beginPreview(commands: RawCommandInput | readonly RawCommandInput[]): PreviewResult {
    const list = toList(commands);
    const base = this.history.project;
    if (this.disposed) {
      return refuse(base, list, "The editor session is closed; nothing can be previewed");
    }
    if (this.history.gestureActive) {
      return refuse(base, list, "Cannot preview while a gesture is in progress");
    }
    const result = executeTransaction(base, list, {
      clock: this.clock,
      // The preview is not a revision; only its commit makes one.
      commitRevision: false,
    });
    if (!result.ok) return result;
    if (this.preview) this.endPreview(this.preview, "cancelled", "superseded", false);
    const preview = new SessionPreview(
      this.previewHost,
      list,
      base,
      result.project,
      result.summary,
    );
    this.preview = preview;
    this.notify();
    return { ok: true, preview };
  }

  /**
   * Opens a continuous edit gesture — a piano-roll note drag, a step-editor
   * paint or erase stroke, a fader or pan drag — that applies each step
   * immediately (so the UI and audio stay live) but commits as one history
   * entry and one revision (PRD section 9.6; CLP-02 "undo groups a single drag
   * gesture", CLP-03 for the piano roll).
   *
   * Autosave is deferred to `commit` and queued from a structural diff against
   * the project as it was when the gesture began: a fader drag persists a
   * single song write, and a stroke or note drag that touches ten steps writes
   * the changed clip document *once*, not once per intermediate frame.
   * `first_edit` fires for the gesture's first command. `cancel` abandons the
   * whole gesture, so nothing is queued and nothing was persisted.
   *
   * The returned gesture's `commit`/`cancel` wrap the history kernel's so
   * callers cannot forget those side effects the way a raw
   * `history.beginGesture()` would let them.
   */
  beginGesture(options: GestureOptions = {}): Gesture {
    const before = this.history.project;
    const gesture = this.history.beginGesture(options);
    let firstEditResult: TransactionSuccess | null = null;
    return {
      get active() {
        return gesture.active;
      },
      // A step that changes the committed project makes an open preview
      // stale (see `onHistoryChange`), like any other local edit.
      apply: (commands) => {
        const result = gesture.apply(commands);
        if (result.ok && !firstEditResult) firstEditResult = result;
        return result;
      },
      commit: (options) => {
        const entry = gesture.commit(options);
        if (!entry) return entry;
        if (firstEditResult) this.logFirstEdit(firstEditResult);
        this.queueDiff(this.history.project, before);
        this.emitEdit({
          kind: "edit",
          actor: entry.actor,
          correlationId: entry.correlationId,
          commands: entry.commands,
          before,
        });
        return entry;
      },
      cancel: () => {
        gesture.cancel();
      },
    };
  }

  /**
   * `actor` is who invoked the undo, not who authored the entry being undone
   * (`history.undo()` already replays the entry's own actor for that).
   * `"assistant"` is the proposal executor undoing an applied proposal
   * (GRV-4), which logs `assistant_proposal_undone` alongside this.
   *
   * An open preview is cancelled first (it ends `stale`, reason `undo`), then
   * the undo acts on the committed history. While a gesture is open the
   * history refuses the undo (it throws), so the preview is left alone.
   */
  undo(actor: "user" | "assistant" = "user"): TransactionResult | null {
    if (!this.history.gestureActive) this.endOpenPreview("stale", "undo");
    const before = this.history.project;
    const undone = this.history.entries.at(-1);
    const result = this.history.undo();
    if (result?.ok) {
      this.queueAutosave(result, before);
      this.analytics.log("undo_used", { direction: "undo", actor });
      this.emitEdit({
        kind: "undo",
        actor: result.actor,
        correlationId: result.correlationId,
        commands: undone?.commands ?? [],
        before,
      });
    }
    return result;
  }

  /** Like `undo`, an open preview is cancelled first (reason `redo`). */
  redo(actor: "user" | "assistant" = "user"): TransactionResult | null {
    if (!this.history.gestureActive) this.endOpenPreview("stale", "redo");
    const before = this.history.project;
    const result = this.history.redo();
    if (result?.ok) {
      this.logFirstEdit(result);
      this.queueAutosave(result, before);
      this.analytics.log("undo_used", { direction: "redo", actor });
      this.emitEdit({ kind: "redo", ...this.editOf(result), before });
    }
    return result;
  }

  /**
   * Called when the page is about to unload (GRV-60). Reports whether an edit
   * would be lost, logging `unsaved_exit_warned` when one would, and starts
   * writing it so it can land while the browser's "leave site?" prompt shows.
   * An edit stays counted in `pending` until a write carrying it succeeds, so
   * this covers a queued, an in-flight and a failed save alike.
   */
  warnBeforeExit(): boolean {
    const { pending, state } = this.autosave.status;
    if (this.disposed || pending === 0) return false;
    this.analytics.log("unsaved_exit_warned", {
      save_state: state === "saving" || state === "failed" ? state : "pending",
    });
    void this.autosave.flush();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endOpenPreview("cancelled", "disposed", false);
    this.listeners.clear();
    this.editListeners.clear();
    this.remoteListeners.clear();
    this.unsubscribeHistory();
    this.unwatch();
    this.autosave.dispose();
    this.history.dispose();
  }

  private execute(
    commands: RawCommandInput | readonly RawCommandInput[],
    options: TransactionOptions = {},
  ): TransactionResult {
    const before = this.history.project;
    const result = this.history.execute(commands, options);
    if (result.ok) {
      this.logFirstEdit(result);
      this.queueAutosave(result, before);
      // Inside an open gesture the history folds the dispatch into it, and
      // the gesture's commit reports the whole of it once.
      if (!this.history.gestureActive) {
        this.emitEdit({ kind: "edit", ...this.editOf(result), before });
      }
    }
    return result;
  }

  private editOf(
    result: TransactionSuccess,
  ): Pick<SessionEdit, "actor" | "correlationId" | "commands"> {
    return {
      actor: result.actor,
      correlationId: result.correlationId,
      commands: result.commands,
    };
  }

  private emitEdit(edit: SessionEdit): void {
    for (const listener of [...this.editListeners]) listener(edit);
  }

  /**
   * The history moved. If the committed project is no longer the one an open
   * preview was computed against, a local edit landed under it: the preview
   * is stale. Ending it here, before listeners hear about the change, means
   * no listener ever sees a preview over a moved committed project.
   */
  private onHistoryChange(): void {
    const preview = this.preview;
    if (preview && this.history.project !== preview.baseProject) {
      this.endPreview(preview, "stale", "local_edit", false);
    }
    this.notify();
  }

  /**
   * A commit is always its own history entry with the caller's actor, or it
   * does not happen. `history.execute` folds anything dispatched during an
   * open gesture into that gesture (under the gesture's actor), so a commit
   * while a gesture is open is refused without applying anything, and the
   * preview stays open: if the gesture is cancelled the preview is still
   * valid and can be committed then; if it commits a change, the preview goes
   * stale like under any other local edit.
   */
  private commitPreview(
    preview: SessionPreview,
    actor: CommandActor,
  ): TransactionResult | null {
    if (this.history.gestureActive) {
      return refuse(
        this.history.project,
        preview.commands,
        "Cannot commit a preview while a gesture is in progress",
      );
    }
    // Ended before dispatching, so the history change the commit causes is
    // not mistaken for a local edit under the preview.
    this.endPreview(preview, "committed", "committed", false);
    const result = this.execute(preview.commands, {
      actor,
      // Belt and braces: an open preview's base is the committed project, so
      // this always holds; it refuses rather than applies if it ever did not.
      baseRevision: preview.baseProject.metadata.revision,
    });
    if (!result.ok) {
      preview.end("cancelled", "commit_failed");
      this.notify();
    }
    return result;
  }

  private endOpenPreview(
    status: Exclude<PreviewStatus, "open">,
    reason: PreviewEndReason,
    notify = true,
  ): void {
    if (this.preview) this.endPreview(this.preview, status, reason, notify);
  }

  private endPreview(
    preview: SessionPreview,
    status: Exclude<PreviewStatus, "open">,
    reason: PreviewEndReason,
    notify = true,
  ): void {
    if (this.preview !== preview) return;
    this.preview = null;
    preview.end(status, reason);
    if (notify) this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /**
   * `project_opened` (PRD `OPS-02`), fired once per `EditorSession` — i.e.
   * once per actual open, not once per project like `first_edit`. Its
   * parameters are not optional: they are what makes the section 11 1- and
   * 7-day reopen measure computable.
   */
  private logProjectOpened(
    project: Project,
    deviceStorage: Storage | null | undefined,
  ): void {
    const ageMs = Math.max(0, this.clock.now() - project.metadata.createdAt);
    this.analytics.log("project_opened", {
      project_age_bucket: projectAgeBucket(ageMs),
      track_count_bucket: bucketOf("track_count", project.song.tracks.length),
      is_first_open: markProjectOpened(this.projectId, deviceStorage),
    });
  }

  private logFirstEdit(result: TransactionSuccess): void {
    if (this.firstEditLogged) return;
    const commandId = result.commands[0]?.type;
    if (!commandId || !isCommandId(commandId)) return;
    this.firstEditLogged = true;
    const secondsSinceOpen = Math.max(0, (this.clock.now() - this.openedAt) / 1000);
    // Once per project (never again on reload), not once per session — the
    // storage-backed `logOnce` key is scoped to the project rather than a
    // per-instance flag, since the marker must survive across reloads.
    this.analytics.logOnce(`first_edit:${this.projectId}`, "first_edit", {
      command_id: commandId,
      seconds_since_open_bucket: bucketOf("elapsed_seconds", secondsSinceOpen),
    });
  }

  /**
   * Queues exactly the tiers a transaction changed, by comparing the project
   * before and after it committed.
   *
   * - A changed `song` reference queues the song document. `saveSong`
   *   recomputes the metadata tier's pack-dependency list in the same
   *   revision-checked step, so a track add/delete that drops or adds a pack
   *   needs no separate metadata write.
   * - A changed `metadata.addedPacks` queues a metadata patch. The shelf is the
   *   one piece of pack state that is *maintained* rather than derived (LIB-08),
   *   so a `pack.add` for a pack no asset uses yet changes no song and no clip —
   *   without this branch it would never reach the repository, and the pack
   *   would vanish on reload.
   * - Every clip whose reference changed (added, edited) is queued, and every
   *   clip that disappeared is queued for deletion. This is a structural diff
   *   rather than a per-command payload scan, so it covers a note edit (one
   *   clip changes), a track duplicate (several new clips), a track delete
   *   (several clip deletions), and a piano-roll note drag with one path.
   *
   * Structural sharing makes the diff cheap: an unchanged song or clip keeps
   * its exact object reference through the immutable edit helpers, so an edit
   * to one track compares `false` for the song and `true` (skip) for every
   * clip it did not touch.
   */
  /**
   * Writes back what loading repaired: the song without the placements whose
   * clips were never stored, and a deletion for each clip document whose track
   * is gone. It is a save, not an edit, so it is not an undo step.
   */
  private queueRepair(project: Project, dropped: DroppedReferences): void {
    if (dropped.placements > 0) {
      this.autosave.queueSong(project.song);
    }
    for (const clipId of dropped.clipIds) {
      this.autosave.queueClipDeletion(clipId);
    }
  }

  private queueAutosave(result: TransactionSuccess, before: Project): void {
    this.queueDiff(result.project, before);
  }

  private queueDiff(next: Project, before: Project): void {
    if (next.song !== before.song) {
      this.autosave.queueSong(next.song);
    }
    if (next.metadata.addedPacks !== before.metadata.addedPacks) {
      this.autosave.queueMetadata({ addedPacks: next.metadata.addedPacks });
    }
    if (next.metadata.name !== before.metadata.name) {
      this.autosave.queueMetadata({ name: next.metadata.name });
    }
    this.queueChangedClips(next, before);
  }

  private queueChangedClips(next: Project, before: Project): void {
    if (next.clips === before.clips) return;
    const beforeById = new Map<ClipId, Clip>(before.clips.map((clip) => [clip.id, clip]));
    for (const clip of next.clips) {
      if (beforeById.get(clip.id) !== clip) {
        this.autosave.queueClip(clip);
      }
      beforeById.delete(clip.id);
    }
    for (const clipId of beforeById.keys()) {
      this.autosave.queueClipDeletion(clipId);
    }
  }
}

function toList(
  commands: RawCommandInput | readonly RawCommandInput[],
): readonly RawCommandInput[] {
  return Array.isArray(commands)
    ? (commands as readonly RawCommandInput[])
    : [commands as RawCommandInput];
}

/** A preview refusal, shaped like the failure a dispatch returns. */
function refuse(
  project: Project,
  commands: readonly RawCommandInput[],
  message: string,
): TransactionFailure {
  return {
    ok: false,
    project,
    issues: [
      {
        code: "rejected",
        commandType: commands[0]?.type ?? "",
        commandIndex: 0,
        message,
      },
    ],
  };
}

export function createEditorSession(options: EditorSessionOptions): EditorSession {
  return new EditorSession(options);
}
