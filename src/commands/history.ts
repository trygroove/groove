import { nanoid } from "nanoid";
import type { Project } from "../domain/entities";
import { checkProjectIntegrity, type DomainIssueCode } from "../domain/parse";
import { type Clock, systemClock } from "../shared/clock";
import {
  createCorrelationId,
  executeTransaction,
  type TransactionOptions,
  type TransactionResult,
} from "./execute";
import type { CommandActor, CommandEnvelope, RawCommandInput } from "./types";

/**
 * Local undo/redo history.
 *
 * Session-scoped and bounded: history holds commands and their generated
 * inverses, never project snapshots, so undoing is replaying an inverse rather
 * than restoring a copy. It is deliberately independent of persistence — a
 * Firestore acknowledgement or a remote echo must not push, drop, or rewrite
 * an entry, and only an explicit `replaceProject` (opening a different project
 * or reloading this one) clears it. A change saved elsewhere is taken in with
 * `adoptProject`, which keeps every entry. Durable, named history is `PRJ-05` in
 * Alpha Milestone 1 and does not change this contract.
 *
 * One history entry is one revision for a single command, a multi-command
 * transaction, and a continuous gesture. The one exception is a run of quick
 * nudges to one control (`GestureCommitOptions.run`): each press still commits
 * its own revision, but the run shares one entry, so one undo takes it back.
 */

export interface HistoryEntry {
  readonly id: string;
  /** One line, shown next to Undo/Redo and used in assistant proposal diffs. */
  readonly summary: string;
  readonly actor: CommandActor;
  readonly correlationId: string;
  readonly commands: readonly CommandEnvelope[];
  readonly inverse: readonly RawCommandInput[];
  readonly baseRevision: number;
  readonly revision: number;
  readonly timestamp: number;
}

export interface HistorySnapshot {
  readonly project: Project;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoSummary: string | null;
  readonly redoSummary: string | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
  /** True while a continuous gesture is open and not yet committed. */
  readonly gestureActive: boolean;
}

/**
 * Entries kept per session. Undo depth is a memory budget, not a product
 * promise: entries hold commands, so the cost is proportional to what was
 * edited rather than to project size.
 */
export const DEFAULT_HISTORY_LIMIT = 100;

export interface CommandHistoryOptions {
  readonly limit?: number;
  readonly clock?: Clock;
}

export interface GestureOptions {
  /** Summary for the single entry the gesture produces. */
  readonly summary?: string;
  readonly actor?: CommandActor;
  readonly correlationId?: string;
}

/**
 * Joins a committed gesture to a run of them: an arrow key held or tapped on
 * one control is one undo step, not one per press (GRV-63).
 *
 * The gesture merges into the newest history entry when that entry was itself
 * committed in the same run (the same `key`) no more than `withinMs` ago, and
 * nothing else has been recorded, undone or redone since. Every merge restarts
 * the window, so a steady run of presses stays one entry however long it is.
 */
export interface GestureRun {
  /** Identifies the run: one control's own key, compared by identity. */
  readonly key: unknown;
  readonly withinMs: number;
}

export interface GestureCommitOptions {
  /** Overrides the summary given when the gesture began. */
  readonly summary?: string;
  readonly run?: GestureRun;
}

/**
 * A continuous gesture — a fader drag, a note drag, a paint stroke. Every step
 * applies immediately so the UI and audio engine stay live, but the whole
 * gesture lands as one history entry and one revision when it commits.
 */
export interface Gesture {
  readonly active: boolean;
  apply(commands: RawCommandInput | readonly RawCommandInput[]): TransactionResult;
  /**
   * Records the gesture as one entry, or into the entry of the run it joins.
   * Returns null when nothing applied.
   */
  commit(options?: string | GestureCommitOptions): HistoryEntry | null;
  /** Abandons the gesture and restores the project as it was when it began. */
  cancel(): void;
}

interface GestureState {
  readonly startProject: Project;
  readonly startRevision: number;
  readonly actor: CommandActor;
  readonly correlationId: string;
  readonly summary?: string;
  readonly commands: CommandEnvelope[];
  readonly inverse: RawCommandInput[];
  readonly summaries: string[];
}

export type HistoryListener = (snapshot: HistorySnapshot) => void;

/**
 * Invariants a gesture's intermediate steps may leave violated. A placement
 * dragged across a neighbour overlaps it until the drop, where the drag resolves
 * the overwrite once (#290) — so passing a neighbour leaves it intact.
 */
const GESTURE_DEFERRED_INVARIANTS: readonly DomainIssueCode[] = ["placement_overlap"];

export class CommandHistory {
  #project: Project;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #gesture: GestureState | null = null;
  /** The run the newest entry belongs to, while it can still be joined. */
  #run: { readonly entry: HistoryEntry; readonly key: unknown; until: number } | null =
    null;
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #listeners = new Set<HistoryListener>();

  constructor(project: Project, options: CommandHistoryOptions = {}) {
    this.#project = project;
    this.#limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_LIMIT);
    this.#clock = options.clock ?? systemClock;
  }

  get project(): Project {
    return this.#project;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get undoSummary(): string | null {
    return this.#undo[this.#undo.length - 1]?.summary ?? null;
  }

  get redoSummary(): string | null {
    return this.#redo[this.#redo.length - 1]?.summary ?? null;
  }

  /** Oldest entry first. */
  get entries(): readonly HistoryEntry[] {
    return this.#undo;
  }

  get redoEntries(): readonly HistoryEntry[] {
    return this.#redo;
  }

  get limit(): number {
    return this.#limit;
  }

  get gestureActive(): boolean {
    return this.#gesture !== null;
  }

  snapshot(): HistorySnapshot {
    return {
      project: this.#project,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoSummary: this.undoSummary,
      redoSummary: this.redoSummary,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
      gestureActive: this.gestureActive,
    };
  }

  /** Framework-free change notification; a Solid store subscribes to this. */
  subscribe(listener: HistoryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Applies one command or an atomic multi-command transaction and records a
   * single history entry. While a gesture is open the commands join that
   * gesture instead, so a shortcut fired mid-drag cannot split the drag into
   * two entries.
   */
  execute(
    commands: RawCommandInput | readonly RawCommandInput[],
    options: TransactionOptions = {},
  ): TransactionResult {
    const list = toList(commands);
    if (this.#gesture) {
      return this.#applyToGesture(list, options);
    }
    const result = executeTransaction(this.#project, list, {
      clock: this.#clock,
      ...options,
    });
    if (!result.ok) {
      return result;
    }
    this.#project = result.project;
    this.#push({
      id: createEntryId(),
      summary: result.summary,
      actor: result.actor,
      correlationId: result.correlationId,
      commands: result.commands,
      inverse: result.inverse,
      baseRevision: result.baseRevision,
      revision: result.revision,
      timestamp: result.timestamp,
    });
    this.#notify();
    return result;
  }

  beginGesture(options: GestureOptions = {}): Gesture {
    if (this.#gesture) {
      throw new Error("A gesture is already in progress; commit or cancel it first");
    }
    const state: GestureState = {
      startProject: this.#project,
      startRevision: this.#project.metadata.revision,
      actor: options.actor ?? "user",
      correlationId: options.correlationId ?? createCorrelationId(),
      summary: options.summary,
      commands: [],
      inverse: [],
      summaries: [],
    };
    this.#gesture = state;
    this.#notify();

    const history = this;
    return {
      get active() {
        return history.#gesture === state;
      },
      apply(commands) {
        if (history.#gesture !== state) {
          throw new Error("This gesture has already finished");
        }
        return history.#applyToGesture(toList(commands));
      },
      commit(options) {
        if (history.#gesture !== state) {
          throw new Error("This gesture has already finished");
        }
        return history.#commitGesture(
          state,
          typeof options === "string" ? { summary: options } : (options ?? {}),
        );
      },
      cancel() {
        if (history.#gesture !== state) {
          return;
        }
        history.#gesture = null;
        history.#project = state.startProject;
        history.#notify();
      },
    };
  }

  /** Undoes the newest entry. Returns null when there is nothing to undo. */
  undo(): TransactionResult | null {
    if (this.#gesture) {
      throw new Error("Cannot undo while a gesture is in progress");
    }
    const entry = this.#undo[this.#undo.length - 1];
    if (!entry) {
      return null;
    }
    const result = executeTransaction(this.#project, entry.inverse, {
      actor: entry.actor,
      correlationId: entry.correlationId,
      summary: `Undo ${entry.summary}`,
      clock: this.#clock,
    });
    if (!result.ok) {
      return result;
    }
    this.#undo.pop();
    this.#redo.push(entry);
    this.#run = null;
    this.#project = result.project;
    this.#notify();
    return result;
  }

  /** Redoes the newest undone entry. Returns null when there is nothing to redo. */
  redo(): TransactionResult | null {
    if (this.#gesture) {
      throw new Error("Cannot redo while a gesture is in progress");
    }
    const entry = this.#redo[this.#redo.length - 1];
    if (!entry) {
      return null;
    }
    const result = executeTransaction(
      this.#project,
      entry.commands.map((command) => ({
        type: command.type,
        version: command.version,
        payload: command.payload,
      })),
      {
        actor: entry.actor,
        correlationId: entry.correlationId,
        summary: entry.summary,
        clock: this.#clock,
      },
    );
    if (!result.ok) {
      return result;
    }
    this.#redo.pop();
    this.#undo.push(entry);
    this.#run = null;
    this.#project = result.project;
    this.#notify();
    return result;
  }

  /**
   * Installs a different project and drops the history. This is the only way
   * history is discarded, and it is deliberate: opening another project or
   * reloading this one. A save acknowledgement or a remote echo must never
   * call it, or an undo would silently stop working.
   */
  replaceProject(project: Project): void {
    this.#gesture = null;
    this.#run = null;
    this.#project = project;
    this.#undo = [];
    this.#redo = [];
    this.#notify();
  }

  /**
   * Installs this project as it was saved elsewhere (another tab's edit) and
   * keeps the history, so this session's own edits stay undoable on top of
   * it (GRV-23). Entries hold commands, not snapshots, so undo and redo replay
   * them onto the adopted project; one that no longer applies fails like any
   * other transaction and stays where it is.
   */
  adoptProject(project: Project): void {
    if (this.#gesture) {
      throw new Error("Cannot adopt a project while a gesture is in progress");
    }
    // The remote change came between: a run of nudges cannot join across it.
    this.#run = null;
    this.#project = project;
    this.#notify();
  }

  /** Drops undo/redo without touching the project. */
  clear(): void {
    this.#run = null;
    this.#undo = [];
    this.#redo = [];
    this.#notify();
  }

  /** Releases every subscriber. Call from the owning component's cleanup. */
  dispose(): void {
    this.#listeners.clear();
  }

  #applyToGesture(
    commands: readonly RawCommandInput[],
    options: TransactionOptions = {},
  ): TransactionResult {
    const gesture = this.#gesture;
    if (!gesture) {
      throw new Error("No gesture is in progress");
    }
    const result = executeTransaction(this.#project, commands, {
      ...options,
      actor: gesture.actor,
      correlationId: gesture.correlationId,
      clock: this.#clock,
      // The gesture commits one revision when it ends, so its steps do
      // not each bump the revision the way a standalone command does.
      commitRevision: false,
      deferredInvariants: GESTURE_DEFERRED_INVARIANTS,
    });
    if (!result.ok) {
      return result;
    }
    gesture.commands.push(...result.commands);
    gesture.inverse.unshift(...result.inverse);
    gesture.summaries.push(result.summary);
    this.#project = result.project;
    this.#notify();
    return result;
  }

  #commitGesture(
    state: GestureState,
    options: GestureCommitOptions,
  ): HistoryEntry | null {
    this.#gesture = null;
    // A step may defer an invariant, but nothing commits in violation of one:
    // a gesture that still breaks one when it ends is abandoned, like a cancel.
    if (checkProjectIntegrity(this.#project).length > 0) {
      this.#project = state.startProject;
      this.#notify();
      return null;
    }
    if (state.commands.length === 0) {
      this.#notify();
      return null;
    }
    const timestamp = this.#clock.now();
    this.#project = {
      ...this.#project,
      metadata: {
        ...this.#project.metadata,
        revision: state.startRevision + 1,
        modifiedAt: Math.max(timestamp, this.#project.metadata.createdAt),
      },
    };
    const entry: HistoryEntry = {
      id: createEntryId(),
      summary: options.summary ?? state.summary ?? state.summaries[0] ?? "Edit project",
      actor: state.actor,
      correlationId: state.correlationId,
      commands: state.commands,
      inverse: state.inverse,
      baseRevision: state.startRevision,
      revision: this.#project.metadata.revision,
      timestamp,
    };
    const recorded = this.#joinRun(entry, options.run) ?? entry;
    if (recorded === entry) this.#push(entry);
    this.#run = options.run
      ? { entry: recorded, key: options.run.key, until: timestamp + options.run.withinMs }
      : null;
    this.#notify();
    return recorded;
  }

  /**
   * Folds `entry` into the newest entry when both belong to the same live run,
   * and returns the merged entry; otherwise returns null. The merged entry
   * replays both halves' commands in order and undoes them newest first.
   */
  #joinRun(entry: HistoryEntry, run: GestureRun | undefined): HistoryEntry | null {
    const previous = this.#run;
    const newest = this.#undo[this.#undo.length - 1];
    if (
      !run ||
      !previous ||
      previous.key !== run.key ||
      previous.entry !== newest ||
      this.#redo.length > 0 ||
      entry.timestamp > previous.until
    ) {
      return null;
    }
    const merged: HistoryEntry = {
      ...newest,
      summary: entry.summary,
      commands: [...newest.commands, ...entry.commands],
      inverse: [...entry.inverse, ...newest.inverse],
      revision: entry.revision,
      timestamp: entry.timestamp,
    };
    this.#undo[this.#undo.length - 1] = merged;
    return merged;
  }

  #push(entry: HistoryEntry): void {
    this.#undo.push(entry);
    // A new edit invalidates the redo branch: history is linear.
    this.#redo = [];
    while (this.#undo.length > this.#limit) {
      this.#undo.shift();
    }
  }

  #notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

export function createCommandHistory(
  project: Project,
  options: CommandHistoryOptions = {},
): CommandHistory {
  return new CommandHistory(project, options);
}

function createEntryId(): string {
  return `hst_${nanoid(21)}`;
}

function toList(
  commands: RawCommandInput | readonly RawCommandInput[],
): readonly RawCommandInput[] {
  return Array.isArray(commands)
    ? (commands as readonly RawCommandInput[])
    : [commands as RawCommandInput];
}
