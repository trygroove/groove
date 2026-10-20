/**
 * Applying, cancelling and undoing an assistant proposal (GRV-4, PRD AI-03).
 *
 * The executor goes through the editor session a manual edit goes through
 * (see {@link ProposalTarget}); it adds no mutation path of its own. `propose` validates the model's response
 * (`proposal.ts`) and hands back a {@link ProposalHandle}:
 *
 * - `apply()` executes the proposal's commands as one transaction, as the
 *   `assistant` actor and pinned to the revision the proposal was validated
 *   against: one revision, one history entry, or no change at all. A project
 *   that moved in the meantime makes the proposal `stale`; it can be
 *   cancelled, never applied.
 * - `cancel()` changes nothing.
 * - `undo()` replays the entry's inverse through the history, but only while
 *   the proposal is still the newest entry, so it can never undo someone
 *   else's edit by mistake.
 * - `followHistory()` is told when the history undid or redid the proposal's
 *   entry by some other way (the header's Undo, a shortcut), so the handle
 *   stays in step: an undo from anywhere is logged as one, and a redo makes
 *   the proposal undoable again.
 *
 * Each step logs its `assistant_proposal_*` event through the injected
 * analytics, with the proposal's capability, a bucketed command count and,
 * for a decision or an undo, a bucketed time. The intent, the summaries and
 * the payloads never go near it.
 */
import type { Analytics } from "../analytics/analytics";
import { bucketOf } from "../analytics/buckets";
import {
  createCorrelationId,
  type TransactionOptions,
  type TransactionResult,
  type TransactionSuccess,
} from "../commands/execute";
import type { CommandIssue, RawCommandInput } from "../commands/types";
import type { Project } from "../domain/entities";
import { type Clock, systemClock } from "../shared/clock";
import {
  type ProposalIssue,
  rejectedProposalShape,
  type ValidProposal,
  validateProposal,
} from "./proposal";
import { editsLeaveProposalValid } from "./proposalStaleness";

/** Whether the edits since `baseRevision` leave a proposal of these commands valid. */
function editsLeaveValid(
  target: ProposalTarget,
  baseRevision: number,
  commandTypes: readonly string[],
): boolean {
  const since = target.commandTypesSince?.(baseRevision) ?? null;
  return editsLeaveProposalValid(since, commandTypes);
}

/**
 * What the executor applies to. In the editor that is the editor session
 * (`src/editor/assistantProposalTarget.ts`), so an applied or undone proposal
 * is autosaved, counted as an edit and ends an open preview exactly as a
 * manual edit or undo does; nothing here reaches the history underneath it.
 */
export interface ProposalTarget {
  /** The committed project, never a preview of one. */
  readonly project: Project;
  /**
   * True while a continuous gesture is open. The history folds anything
   * executed then into the gesture, so a proposal waits for it to finish
   * rather than becoming part of someone's drag.
   */
  readonly gestureActive: boolean;
  /** The newest undo entry's correlation ID, or null with nothing to undo. */
  readonly latestCorrelationId: string | null;
  /**
   * The command types committed after `revision`, oldest first, or null when
   * they are not all known (a change adopted from elsewhere, or history older
   * than the target keeps). Without it, any revision change makes a proposal
   * stale.
   */
  commandTypesSince?(revision: number): readonly string[] | null;
  execute(
    commands: readonly RawCommandInput[],
    options: TransactionOptions,
  ): TransactionResult;
  /** Undoes the newest entry, on the assistant's behalf. */
  undo(): TransactionResult | null;
}

/** The analytics the executor logs through. */
export type ProposalAnalytics = Pick<Analytics, "log">;

export interface ProposalExecutorOptions {
  readonly target: ProposalTarget;
  readonly analytics: ProposalAnalytics;
  readonly clock?: Clock;
}

/**
 * - `pending`: shown, not yet decided.
 * - `applied`: committed as one history entry.
 * - `cancelled`: the producer turned it down; nothing changed.
 * - `stale`: the project moved under it; it can only be cancelled.
 * - `undone`: applied, then undone.
 */
export type ProposalStatus = "pending" | "applied" | "cancelled" | "stale" | "undone";

export type ProposalRefusal =
  /** The proposal is not in a state this action applies to. */
  | "not_pending"
  | "not_applied"
  /** The project moved since the proposal was validated. */
  | "stale"
  /** Something was committed after the proposal, so undoing it is not exact. */
  | "not_latest"
  /** A gesture is open; try again once it ends. */
  | "busy"
  /** The kernel refused (cannot happen for a proposal that dry-ran cleanly). */
  | "failed";

export type ProposalActionResult =
  | { readonly ok: true; readonly result: TransactionSuccess | null }
  | {
      readonly ok: false;
      readonly reason: ProposalRefusal;
      readonly issues: readonly CommandIssue[];
    };

export interface ProposalHandle {
  /** The correlation ID the applied transaction and its history entry carry. */
  readonly id: string;
  readonly proposal: ValidProposal;
  readonly status: ProposalStatus;
  /**
   * True once the project has moved since the proposal was validated, so it
   * can no longer be applied: before `apply()` tries and finds out.
   */
  readonly isStale: boolean;
  apply(): ProposalActionResult;
  cancel(): ProposalActionResult;
  undo(): ProposalActionResult;
  /**
   * The history undid or redid this proposal's entry (matched by its
   * correlation ID), whoever asked. A no-op when the handle is already there,
   * as after its own `undo()`.
   */
  followHistory(kind: "undo" | "redo"): void;
}

export type ProposeResult =
  | { readonly ok: true; readonly handle: ProposalHandle }
  | { readonly ok: false; readonly issues: readonly ProposalIssue[] };

export interface ProposalExecutor {
  /**
   * Validates a model's proposal against the target's committed project.
   * A valid one is shown (`assistant_proposal_shown`) and returned as a
   * pending handle; an invalid one changes nothing and logs
   * `assistant_proposal_rejected` once, with its issue codes only (GRV-98).
   */
  propose(input: unknown): ProposeResult;
}

function seconds(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / 1000;
}

function refuse(
  reason: ProposalRefusal,
  issues: readonly CommandIssue[] = [],
): ProposalActionResult {
  return { ok: false, reason, issues };
}

class Handle implements ProposalHandle {
  readonly id = createCorrelationId("asp");
  #status: ProposalStatus = "pending";
  readonly #shownAt: number;
  #appliedAt = 0;

  constructor(
    readonly proposal: ValidProposal,
    private readonly options: Required<ProposalExecutorOptions>,
  ) {
    this.#shownAt = options.clock.now();
    options.analytics.log("assistant_proposal_shown", {
      capability: proposal.capability,
      command_count_bucket: this.#commandCount(),
    });
  }

  get status(): ProposalStatus {
    return this.#status;
  }

  get isStale(): boolean {
    if (this.#status === "stale") return true;
    return this.#status === "pending" && this.#moved() && !this.#stillValid();
  }

  apply(): ProposalActionResult {
    if (this.#status !== "pending") return refuse("not_pending");
    const { target, analytics, clock } = this.options;
    if (target.gestureActive) return refuse("busy");
    if (this.#moved() && !this.#stillValid()) {
      this.#status = "stale";
      return refuse("stale");
    }
    const result = target.execute(this.proposal.commands, {
      actor: "assistant",
      correlationId: this.id,
      // Edits that cannot affect the proposal moved the revision; the
      // transaction still checks every invariant against the song as it is.
      ...(this.#moved() ? {} : { baseRevision: this.proposal.baseRevision }),
    });
    if (!result.ok) {
      const stale = result.issues.some((issue) => issue.code === "revision_conflict");
      if (stale) this.#status = "stale";
      return refuse(stale ? "stale" : "failed", result.issues);
    }
    this.#status = "applied";
    this.#appliedAt = clock.now();
    analytics.log("assistant_proposal_applied", {
      capability: this.proposal.capability,
      command_count_bucket: this.#commandCount(),
      seconds_to_decision_bucket: bucketOf(
        "elapsed_seconds",
        seconds(this.#shownAt, this.#appliedAt),
      ),
    });
    return { ok: true, result };
  }

  cancel(): ProposalActionResult {
    if (this.#status !== "pending" && this.#status !== "stale") {
      return refuse("not_pending");
    }
    const { analytics, clock } = this.options;
    this.#status = "cancelled";
    analytics.log("assistant_proposal_cancelled", {
      capability: this.proposal.capability,
      command_count_bucket: this.#commandCount(),
      seconds_to_decision_bucket: bucketOf(
        "elapsed_seconds",
        seconds(this.#shownAt, clock.now()),
      ),
    });
    return { ok: true, result: null };
  }

  undo(): ProposalActionResult {
    if (this.#status !== "applied") return refuse("not_applied");
    const { target } = this.options;
    if (target.gestureActive) return refuse("busy");
    if (target.latestCorrelationId !== this.id) return refuse("not_latest");
    const result = target.undo();
    if (!result) return refuse("not_latest");
    if (!result.ok) return refuse("failed", result.issues);
    // The target may already have reported the undo back (`followHistory`).
    if (this.#status === "applied") this.#markUndone();
    return { ok: true, result };
  }

  followHistory(kind: "undo" | "redo"): void {
    if (kind === "undo" && this.#status === "applied") {
      this.#markUndone();
    } else if (kind === "redo" && this.#status === "undone") {
      this.#status = "applied";
      this.#appliedAt = this.options.clock.now();
    }
  }

  #markUndone() {
    const { analytics, clock } = this.options;
    this.#status = "undone";
    analytics.log("assistant_proposal_undone", {
      capability: this.proposal.capability,
      command_count_bucket: this.#commandCount(),
      seconds_to_undo_bucket: bucketOf(
        "elapsed_seconds",
        seconds(this.#appliedAt, clock.now()),
      ),
    });
  }

  #moved(): boolean {
    return this.options.target.project.metadata.revision !== this.proposal.baseRevision;
  }

  #stillValid(): boolean {
    return editsLeaveValid(
      this.options.target,
      this.proposal.baseRevision,
      this.proposal.commands.map((command) => command.type),
    );
  }

  #commandCount() {
    return bucketOf("command_count", this.proposal.commands.length);
  }
}

/**
 * `assistant_proposal_rejected`: codes, a capability and a bucketed count,
 * nothing else. A streamed proposal's card (GRV-144) logs one for each part
 * that does not fit.
 */
export function logProposalRejection(
  analytics: ProposalAnalytics,
  input: unknown,
  issues: readonly ProposalIssue[],
): void {
  const first = issues[0];
  if (!first) return;
  const shape = rejectedProposalShape(input);
  analytics.log("assistant_proposal_rejected", {
    kind: issues.some((issue) => issue.code === "stale_revision") ? "stale" : "invalid",
    capability: shape.capability ?? "unknown",
    command_count_bucket: bucketOf("command_count", shape.commandCount),
    issue_code: first.code,
    issue_code_count: new Set(issues.map((issue) => issue.code)).size,
  });
}

export function createProposalExecutor(
  options: ProposalExecutorOptions,
): ProposalExecutor {
  const resolved: Required<ProposalExecutorOptions> = {
    clock: systemClock,
    ...options,
  };
  return {
    propose(input) {
      const validation = validateProposal(
        resolved.target.project,
        input,
        (baseRevision, types) => editsLeaveValid(resolved.target, baseRevision, types),
      );
      if (!validation.ok) {
        logProposalRejection(resolved.analytics, input, validation.issues);
        return validation;
      }
      return { ok: true, handle: new Handle(validation.proposal, resolved) };
    },
  };
}
