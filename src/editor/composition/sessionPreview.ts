import type {
  CommandActor,
  RawCommandInput,
  TransactionFailure,
  TransactionResult,
} from "../../commands";
import type { Project } from "../../domain/entities";

/**
 * Where an uncommitted preview stands (UI-005, #851).
 *
 * - `open`: the editor shows the previewed project.
 * - `committed`: `commit(actor)` dispatched its commands as one transaction.
 * - `cancelled`: `cancel()` was called, another preview replaced it, or the
 *   session closed.
 * - `stale`: the committed project moved under it (a local edit, a remote
 *   change, an undo or a redo), so it cancelled itself. A stale preview can
 *   never be committed.
 */
export type PreviewStatus = "open" | "committed" | "cancelled" | "stale";

/** Why a preview stopped being open. `null` while it still is. */
export type PreviewEndReason =
  | "cancelled"
  | "committed"
  | "commit_failed"
  | "superseded"
  | "disposed"
  | "local_edit"
  | "remote_change"
  | "undo"
  | "redo";

/**
 * A handle on one uncommitted preview, from `EditorSession.beginPreview`.
 *
 * It knows nothing about who proposed the commands: `commit` takes the actor
 * as a parameter, so the assistant (#72) passes `assistant` and nothing here
 * changes for any other caller.
 */
export interface Preview {
  readonly status: PreviewStatus;
  readonly endReason: PreviewEndReason | null;
  /** The commands being previewed, exactly as they were handed over. */
  readonly commands: readonly RawCommandInput[];
  /** The committed project the preview was computed against. */
  readonly baseProject: Project;
  /** The project the editor shows while the preview is open. */
  readonly project: Project;
  /** One line describing the previewed change, as a history entry would. */
  readonly summary: string;
  /** Puts the committed project back. A no-op once the preview has ended. */
  cancel(): void;
  /**
   * Dispatches the previewed commands as one transaction: one history entry,
   * one revision, one autosave. Returns `null` without touching anything when
   * the preview is no longer open — a stale preview is never applied.
   */
  commit(actor: CommandActor): TransactionResult | null;
}

/** A valid preview's handle, or the same failure a dispatch would return. */
export type PreviewResult =
  | { readonly ok: true; readonly preview: Preview }
  | TransactionFailure;

/** What `SessionPreview` asks of the session that owns it. */
export interface PreviewHost {
  cancelPreview(preview: SessionPreview): void;
  commitPreview(preview: SessionPreview, actor: CommandActor): TransactionResult | null;
}

/**
 * The session-owned implementation behind {@link Preview}. Only
 * `EditorSession` constructs one or calls `end`; callers see the readonly
 * interface.
 */
export class SessionPreview implements Preview {
  #status: PreviewStatus = "open";
  #endReason: PreviewEndReason | null = null;

  constructor(
    private readonly host: PreviewHost,
    readonly commands: readonly RawCommandInput[],
    readonly baseProject: Project,
    readonly project: Project,
    readonly summary: string,
  ) {}

  get status(): PreviewStatus {
    return this.#status;
  }

  get endReason(): PreviewEndReason | null {
    return this.#endReason;
  }

  get open(): boolean {
    return this.#status === "open";
  }

  cancel(): void {
    if (!this.open) return;
    this.host.cancelPreview(this);
  }

  commit(actor: CommandActor): TransactionResult | null {
    if (!this.open) return null;
    return this.host.commitPreview(this, actor);
  }

  /** Records how the preview ended. Only the owning session calls this. */
  end(status: Exclude<PreviewStatus, "open">, reason: PreviewEndReason): void {
    this.#status = status;
    this.#endReason = reason;
  }
}
