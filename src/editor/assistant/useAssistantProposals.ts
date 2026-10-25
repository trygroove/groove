/**
 * The assistant's proposal cards (GRV-5): one per proposal a reply makes,
 * and what Preview, Cancel, Apply, Undo and Refresh do to it.
 *
 * - **Preview** opens the session's uncommitted preview (#851), outlines the
 *   controls it changes (dashed) and moves the editor to the view and track
 *   that show the change, leaving focus on the card. No history entry, no
 *   save.
 * - **Cancel** ends a preview and returns the editor to where it was; with no
 *   preview open it turns the proposal down.
 * - **Apply** commits the proposal through the executor (GRV-4): one
 *   transaction, one undo entry. Its controls stay outlined in solid white
 *   until the next edit, and the card offers Undo.
 * - A proposal the song moved under (an edit here, an undo, a change from
 *   elsewhere) is **stale**: Apply is off and **Refresh** asks again in the
 *   same scope. So is one still waiting when the page reloaded, which comes
 *   back with the conversation (GRV-135).
 *
 * Applying records the addresses the proposal touched for the session. A
 * later edit by hand to any of them logs `assistant_result_edited` once for
 * that proposal, which then stops being watched.
 *
 * Nothing here mutates a project itself: the executor and the preview both go
 * through the editor session.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import { validateProposal } from "../../assistant/proposal";
import {
  createProposalExecutor,
  type ProposalExecutor,
  type ProposalHandle,
  type ProposalTarget,
} from "../../assistant/proposalExecutor";
import type { AssistantProposal, AssistantProposalPart } from "../../assistant/protocol";
import type { ProposalCapability } from "../../assistant/tools";
import type { ProposalOutcome, TranscriptIssue } from "../../assistant/transcripts";
import {
  type ControlAddress,
  controlKey,
  uniqueControls,
} from "../../commands/controlAddress";
import { controlsTouchedBy } from "../../commands/controls";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import type { Clock } from "../../shared/clock";
import type { PreviewResult, SessionEdit } from "../composition/EditorSession";
import type { EditorControls, EditorLocation } from "../composition/editorControls";
import type { EditorViewName } from "../composition/editorViews";
import type { Preview } from "../composition/sessionPreview";
import {
  explainProposal,
  type ProposalExplanation,
  type ProposalRow,
  previewTarget,
  projectAfter,
  proposalRows,
} from "./proposalCardModel";
import { rejectionReason } from "./rejectionReason";
import { transcriptIssues } from "./transcriptIssues";
import type { ShownPart, TurnOrigin } from "./useAssistantConversation";
import {
  type StreamedProposalCard,
  type StreamedTurn,
  useStreamedProposals,
} from "./useStreamedProposals";

/**
 * - `pending`: shown, nothing changed.
 * - `previewing`: shown applied, uncommitted.
 * - `applied`: committed as one undo step.
 * - `undone`: applied, then undone.
 * - `cancelled`: turned down; nothing changed.
 * - `stale`: the song changed under it; it cannot be applied.
 * - `invalid`: it does not fit the song at all (a refused value, a missing ID);
 *   its `reason` says which change, in plain words (GRV-98).
 */
export type ProposalCardStatus =
  | "pending"
  | "previewing"
  | "applied"
  | "undone"
  | "cancelled"
  | "stale"
  | "invalid";

/** Everything one card shows. */
export interface ProposalCard {
  readonly status: ProposalCardStatus;
  /** What the producer asked for, which titles the card. */
  readonly title: string;
  readonly scopeLabel: string;
  readonly rows: readonly ProposalRow[];
  /** "Why this works", for a proposal that fits the song and came explained. */
  readonly explanation: ProposalExplanation | null;
  /** The view Preview shows the change in, or `null` to stay where it is. */
  readonly previewView: EditorViewName | null;
  /** While previewing, the view Cancel returns to. */
  readonly returnView: EditorViewName | null;
  /** Whether Refresh has already asked again for this one. */
  readonly refreshed: boolean;
  /** A one-off note after an action could not be done (an Undo too late). */
  readonly notice: string | null;
  /** For an invalid one: which change did not fit, in plain words (GRV-98). */
  readonly reason: string | null;
  /** Its changed controls still wear the solid outline (until the next edit). */
  readonly outlined: boolean;
  /** It was waiting when the page reloaded, and came back out of date (GRV-135). */
  readonly restored: boolean;
}

/** What the cards need from the editor session (`useEditorSession`). */
export interface ProposalSessionPort {
  proposalTarget(): ProposalTarget | undefined;
  beginPreview(commands: readonly RawCommandInput[]): PreviewResult | undefined;
  onEdit(listener: (edit: SessionEdit) => void): () => void;
  onRemoteChange(listener: () => void): () => void;
  /** Whether a preview is open. Reactive. */
  previewing(): boolean;
}

export interface UseAssistantProposalsOptions {
  readonly session: ProposalSessionPort;
  readonly controls: Pick<EditorControls, "registry" | "revealControl" | "restoreView">;
  /** The project on screen, for working out where a control lives. */
  readonly project: Accessor<Project | null>;
  readonly analytics: () => Analytics;
  /**
   * Asks again, in the same scope, for the proposal in this entry; for a
   * streamed one, naming the parts it showed and which were applied.
   */
  refresh(entryId: string, shown?: readonly ShownPart[]): boolean;
  /**
   * Asks for the rest of a streamed proposal whose turn failed partway
   * (GRV-144). Without it the card offers no Try again.
   */
  continueRest?(entryId: string, shown: readonly ShownPart[]): boolean;
  /** What times a streamed proposal's first part (GRV-144); the real clock by default. */
  readonly clock?: Clock;
  /**
   * Hears what became of a proposal: turned down, applied (or redone),
   * undone, or rejected with the issues that rejected it (GRV-98), so a kept
   * transcript can record it (GRV-8).
   */
  onOutcome?(
    entryId: string,
    outcome: ProposalOutcome,
    issues?: readonly TranscriptIssue[],
  ): void;
  /**
   * The producer pressed Apply (or a streamed card's Apply on a part, or Apply
   * all) and it committed (GRV-195). A redo is not an apply: it is heard as an
   * `applied` outcome only. `applyId` names that one Apply (its correlation
   * ID), so undoing one part of a streamed card is told apart from the rest.
   */
  onApplied?(entryId: string, applyId: string): void;
  /** What one Apply committed was undone, by whatever undid it (GRV-195). */
  onApplyUndone?(applyId: string): void;
}

export interface AssistantProposals {
  /** The card for a conversation entry. Reactive. */
  card(entryId: string): ProposalCard | undefined;
  /** Whether any card is previewing, for the panel's status. Reactive. */
  readonly previewing: Accessor<boolean>;
  /**
   * Whether a card has been decided (GRV-129): applied, declined, refused as
   * not fitting the song, or asked for again, so the panel can show the
   * turn's next card. Reactive.
   */
  decided(entryId: string): boolean;
  /** Whether a card was turned down, or never fitted the song. Reactive. */
  declined(entryId: string): boolean;
  /**
   * A proposal arrived in a reply: validate it and show its card. For an
   * entry whose parts streamed (GRV-144), the whole proposal at the end of
   * the turn, which explains it.
   */
  receive(entryId: string, proposal: AssistantProposal, origin: TurnOrigin): void;
  /** A streamed proposal's card, when the entry's parts streamed (GRV-144). Reactive. */
  streamed(entryId: string): StreamedProposalCard | undefined;
  /** One part of a proposal, as the gateway accepted it (GRV-144). */
  receivePart(
    entryId: string,
    part: AssistantProposalPart,
    origin: TurnOrigin,
    baseRevision: number,
  ): void;
  /** How the turn behind a streamed proposal ended (GRV-144). */
  endStream(entryId: string, ending: Exclude<StreamedTurn, "running">): void;
  /** Applies one part of a streamed proposal as its own undo step (GRV-144). */
  applyPart(entryId: string, index: number): void;
  /** Asks for the rest of a streamed proposal whose turn failed (GRV-144). */
  continueRest(entryId: string): void;
  preview(entryId: string): void;
  cancel(entryId: string): void;
  /**
   * Apply: the whole proposal, or for a streamed one (GRV-144) Apply all,
   * every part not yet applied as one undo step.
   */
  apply(entryId: string): void;
  undo(entryId: string): void;
  refresh(entryId: string): void;
  /** A control link: shows the control and focuses it. */
  reveal(address: ControlAddress): void;
  /**
   * Ends every card's open preview, as another preview opens in their place
   * (a take heard, GRV-207): one preview at a time.
   */
  endPreviews(): void;
  /**
   * How many changes made elsewhere have been adopted this session. A turn
   * records it when sent, so its proposal can tell if one landed meanwhile.
   */
  remoteChanges(): number;
}

/** What the card keeps beside what it shows. */
interface Entry {
  readonly handle: ProposalHandle | null;
  readonly addresses: readonly ControlAddress[];
  preview: Preview | null;
  /** Where the editor was when the preview opened. */
  location: EditorLocation | null;
  /** Watching for a later edit by hand, after it was applied. */
  watching: boolean;
  /** `assistant_result_edited` has been logged for it; nothing watches it again. */
  reported: boolean;
  /** Its controls wear the solid outline. */
  marked: boolean;
}

const CANNOT_UNDO =
  "Something else changed after it, so undo it from the header's Undo instead.";
const BUSY = "Finish the change you're making first, then try again.";

export function useAssistantProposals(
  options: UseAssistantProposalsOptions,
): AssistantProposals {
  const { session, controls } = options;
  const [cards, setCards] = createSignal<ReadonlyMap<string, ProposalCard>>(new Map());
  const entries = new Map<string, Entry>();
  let remoteChanges = 0;
  let executor: ProposalExecutor | null = null;
  // A proposal whose parts streamed (GRV-144) is a card of its own kind.
  const streamed = useStreamedProposals({
    session,
    controls,
    project: options.project,
    analytics: options.analytics,
    clock: options.clock,
    refresh: (entryId, shown) => options.refresh(entryId, shown),
    continueRest: (entryId, shown) => options.continueRest?.(entryId, shown) ?? false,
    onPreviewOpen: () => endWholePreviews(),
    onOutcome: (entryId, outcome, issues) =>
      options.onOutcome?.(entryId, outcome, issues),
    onApplied: (entryId, applyId) => options.onApplied?.(entryId, applyId),
    onApplyUndone: (applyId) => options.onApplyUndone?.(applyId),
  });

  /** Ends every whole proposal's open preview, as a streamed card's opens. */
  function endWholePreviews() {
    for (const [entryId, entry] of entries) {
      if (!entry.preview) continue;
      endPreview(entry);
      update(entryId, { status: "pending", returnView: null });
    }
  }

  const update = (entryId: string, change: Partial<ProposalCard>) =>
    setCards((current) => {
      const card = current.get(entryId);
      if (!card) return current;
      const next = new Map(current);
      next.set(entryId, { ...card, notice: null, ...change });
      return next;
    });

  /** The session's committed project, through a target that always asks the open session. */
  const target: ProposalTarget = {
    get project() {
      return required().project;
    },
    get gestureActive() {
      return required().gestureActive;
    },
    get latestCorrelationId() {
      return required().latestCorrelationId;
    },
    // Which edits landed since a proposal's revision, so one that leaves it
    // valid (the loop, the name) does not make it stale (GRV-132). A take
    // picked (GRV-207) is checked the same way before it becomes a proposal.
    commandTypesSince: (revision) => required().commandTypesSince?.(revision) ?? null,
    execute: (commands, transaction) => required().execute(commands, transaction),
    undo: () => required().undo(),
  };
  function required(): ProposalTarget {
    const current = session.proposalTarget();
    if (!current) throw new Error("The assistant's proposal has no open project");
    return current;
  }

  function receive(entryId: string, proposal: AssistantProposal, origin: TurnOrigin) {
    // A streamed card none of whose parts fit becomes the card of a whole
    // proposal that does not, which says why (GRV-98).
    if (streamed.has(entryId) && !streamed.releaseRefused(entryId)) {
      streamed.finish(entryId, proposal);
      return;
    }
    const base: Omit<ProposalCard, "status"> = {
      title: origin.text,
      scopeLabel: origin.scope.label,
      rows: [],
      explanation: null,
      previewView: null,
      returnView: null,
      refreshed: false,
      notice: null,
      outlined: false,
      reason: null,
      restored: false,
    };
    const current = session.proposalTarget();
    if (!current) return;
    if (origin.restored) {
      restore(entryId, proposal, current.project, base);
      return;
    }
    executor ??= createProposalExecutor({ target, analytics: options.analytics() });
    const proposed = executor.propose(proposal);
    if (!proposed.ok) {
      const stale = proposed.issues.some((issue) => issue.code === "stale_revision");
      const issues = transcriptIssues(proposal, proposed.issues);
      entries.set(entryId, blankEntry(null, []));
      show(entryId, {
        ...base,
        status: stale ? "stale" : "invalid",
        reason: stale ? null : rejectionReason(issues),
      });
      options.onOutcome?.(entryId, "rejected", issues);
      return;
    }
    const { handle } = proposed;
    const before = current.project;
    const rows = proposalRows(
      before,
      projectAfter(before, handle.proposal),
      handle.proposal.impact.controls,
    );
    entries.set(entryId, blankEntry(handle, handle.proposal.impact.controls));
    // A change made elsewhere while the reply was written moved the song
    // under it, though not this session's revision.
    const movedElsewhere = remoteChanges !== origin.remoteChanges;
    const arrived: ProposalCard = {
      ...base,
      status: movedElsewhere ? "stale" : "pending",
      rows,
      explanation: explainProposal(handle.proposal, rows),
      previewView: previewTarget(before, rows)?.view ?? null,
    };
    show(entryId, arrived);
    if (movedElsewhere) return;
    // A take the producer picked (GRV-207) is applied as it arrives: picking
    // was the decision. The card just shown is passed in; a signal write is
    // not readable until it flushes.
    if (origin.fromTake) {
      applyCard(entryId, arrived);
      return;
    }
    // The preview is what makes a proposal understandable: it opens by itself
    // (GRV-193).
    openPreview(entryId, true, arrived);
  }

  /**
   * A proposal from before a reload (GRV-135): shown out of date, with the
   * changes it would make to the song as it is now when it still fits, so
   * Refresh is offered and Apply is not. It was shown and logged before the
   * reload, so nothing is logged or reported again.
   */
  function restore(
    entryId: string,
    proposal: AssistantProposal,
    project: Project,
    base: Omit<ProposalCard, "status">,
  ) {
    const validation = validateProposal(project, proposal);
    const rows = validation.ok
      ? proposalRows(
          project,
          projectAfter(project, validation.proposal),
          validation.proposal.impact.controls,
        )
      : [];
    entries.set(entryId, blankEntry(null, []));
    show(entryId, { ...base, status: "stale", rows, restored: true });
  }

  function show(entryId: string, card: ProposalCard) {
    setCards((current) => new Map(current).set(entryId, card));
  }

  function preview(entryId: string) {
    if (streamed.has(entryId)) {
      streamed.preview(entryId);
      return;
    }
    openPreview(entryId, false);
  }

  /** Opens a whole proposal's preview; `automatic` is the assistant doing so as it arrives. */
  function openPreview(entryId: string, automatic: boolean, arrived?: ProposalCard) {
    const entry = entries.get(entryId);
    const card = arrived ?? cards().get(entryId);
    if (!entry?.handle || card?.status !== "pending") return;
    if (entry.handle.isStale) {
      update(entryId, { status: "stale" });
      return;
    }
    // One preview at a time. Others end only once this one opened (the
    // session supersedes theirs), so a preview that cannot open leaves the
    // producer's own in place.
    const opened = session.beginPreview(entry.handle.proposal.commands);
    if (!opened?.ok) {
      // A preview nobody asked for says nothing when it cannot open.
      if (!automatic) update(entryId, { notice: BUSY });
      return;
    }
    // The place another card's preview came from is where this one's Cancel returns to.
    let location: EditorLocation | null = null;
    for (const [otherId, other] of entries) {
      if (otherId === entryId || !other.preview) continue;
      location = other.location;
      endPreview(other);
      update(otherId, { status: "pending", returnView: null });
    }
    streamed.endPreviews();
    entry.preview = opened.preview;
    controls.registry.setMark(entry.addresses, "previewed");
    const project = options.project();
    const shown = project ? previewTarget(project, card.rows) : null;
    const from = shown ? controls.revealControl(shown.address, { focus: false }) : null;
    entry.location = location ?? from;
    update(entryId, {
      status: "previewing",
      returnView: entry.location?.view ?? null,
    });
    options.analytics().log("assistant_proposal_previewed", { automatic });
    options.analytics().logFeatureFirstUse("assistant_proposal");
  }

  /** Ends a card's open preview, and clears its dashed outlines. */
  function endPreview(entry: Entry) {
    const open = entry.preview;
    entry.preview = null;
    controls.registry.setMark(entry.addresses, entry.marked ? "changed" : "none");
    open?.cancel();
  }

  function cancel(entryId: string) {
    if (streamed.has(entryId)) {
      streamed.cancel(entryId);
      return;
    }
    const entry = entries.get(entryId);
    const card = cards().get(entryId);
    if (!entry || !card) return;
    if (card.status === "previewing") {
      const location = entry.location;
      endPreview(entry);
      entry.location = null;
      if (location) controls.restoreView(location);
      update(entryId, {
        status: entry.handle?.isStale ? "stale" : "pending",
        returnView: null,
      });
      return;
    }
    if (
      card.status !== "pending" &&
      card.status !== "stale" &&
      card.status !== "invalid"
    ) {
      return;
    }
    entry.handle?.cancel();
    update(entryId, { status: "cancelled" });
    options.onOutcome?.(entryId, "cancelled");
  }

  function apply(entryId: string) {
    if (streamed.has(entryId)) {
      streamed.applyAll(entryId);
      return;
    }
    applyCard(entryId);
  }

  /** Applies a whole proposal's card; `arrived` is one just shown, not yet readable. */
  function applyCard(entryId: string, arrived?: ProposalCard) {
    const entry = entries.get(entryId);
    const card = arrived ?? cards().get(entryId);
    const handle = entry?.handle;
    if (!entry || !handle || !card) return;
    if (card.status !== "pending" && card.status !== "previewing") return;
    if (handle.isStale) {
      if (entry.preview) endPreview(entry);
      update(entryId, { status: "stale", returnView: null });
      return;
    }
    // The preview shows exactly what Apply commits; it ends first so the
    // commit is the executor's one transaction, under its own correlation ID.
    // The editor stays on the view that shows the change.
    if (entry.preview) endPreview(entry);
    entry.location = null;
    const result = handle.apply();
    if (!result.ok) {
      if (result.reason === "busy") {
        update(entryId, { status: "pending", returnView: null, notice: BUSY });
      } else {
        update(entryId, { status: "stale", returnView: null });
      }
      return;
    }
    entry.watching = true;
    entry.marked = true;
    controls.registry.setMark(entry.addresses, "changed");
    update(entryId, { status: "applied", returnView: null, outlined: true });
    options.onOutcome?.(entryId, "applied");
    options.onApplied?.(entryId, handle.id);
    options.analytics().logFeatureFirstUse("assistant_proposal");
  }

  function undo(entryId: string) {
    if (streamed.has(entryId)) {
      streamed.undo(entryId);
      return;
    }
    const handle = entries.get(entryId)?.handle;
    if (!handle || cards().get(entryId)?.status !== "applied") return;
    const result = handle.undo();
    // The session reports the undo, and that is what turns the card (below).
    if (!result.ok)
      update(entryId, { notice: result.reason === "busy" ? BUSY : CANNOT_UNDO });
  }

  function refresh(entryId: string) {
    if (streamed.has(entryId)) {
      streamed.refresh(entryId);
      return;
    }
    const card = cards().get(entryId);
    if (card?.status !== "stale" || card.refreshed) return;
    if (options.refresh(entryId)) update(entryId, { refreshed: true });
  }

  /** The cards the song moved under go stale; a preview the session ended goes too. */
  function reconcile() {
    for (const [entryId, entry] of entries) {
      const status = cards().get(entryId)?.status;
      if (status !== "pending" && status !== "previewing") continue;
      const previewEnded = entry.preview !== null && entry.preview.status !== "open";
      if (previewEnded) {
        entry.preview = null;
        entry.location = null;
        controls.registry.setMark(entry.addresses, "none");
      }
      if (entry.handle?.isStale) {
        update(entryId, { status: "stale", returnView: null });
      } else if (previewEnded) {
        update(entryId, { status: "pending", returnView: null });
      }
    }
  }

  function onEdit(edit: SessionEdit) {
    const own = [...entries.entries()].find(
      ([, entry]) => entry.handle?.id === edit.correlationId,
    );
    if (own && edit.kind === "edit") {
      // The apply itself: it is what the outline marks.
      reconcile();
      return;
    }
    clearChangedMarks();
    if (own) {
      const [entryId, entry] = own;
      // Whoever undid or redid it (the card, the header, a shortcut), the
      // handle follows, so the card's Undo works again after a redo.
      if (edit.kind === "undo" || edit.kind === "redo") {
        entry.handle?.followHistory(edit.kind);
      }
      if (edit.kind === "undo") {
        entry.watching = false;
        update(entryId, { status: "undone" });
        if (entry.handle) options.onApplyUndone?.(entry.handle.id);
        options.onOutcome?.(entryId, "undone");
      } else if (edit.kind === "redo") {
        entry.watching = !entry.reported;
        update(entryId, { status: "applied" });
        options.onOutcome?.(entryId, "applied");
      }
    } else if (edit.kind === "edit" && edit.actor === "user") {
      noticeEditByHand(edit);
    }
    reconcile();
  }

  function clearChangedMarks() {
    for (const [entryId, entry] of entries) {
      if (!entry.marked) continue;
      entry.marked = false;
      if (!entry.preview) controls.registry.setMark(entry.addresses, "none");
      update(entryId, { outlined: false });
    }
  }

  /** A producer's own edit to a control an applied proposal changed. */
  function noticeEditByHand(edit: SessionEdit) {
    const touched = new Set(touchedBy(edit).map(controlKey));
    for (const entry of entries.values()) {
      if (!entry.watching || !entry.handle) continue;
      if (!entry.addresses.some((address) => touched.has(controlKey(address)))) continue;
      entry.watching = false;
      entry.reported = true;
      const capability: ProposalCapability = entry.handle.proposal.capability;
      options.analytics().log("assistant_result_edited", { capability });
    }
  }

  function onRemoteChange() {
    remoteChanges += 1;
    // A change made elsewhere moves the saved song under every open proposal.
    for (const [entryId, entry] of entries) {
      const status = cards().get(entryId)?.status;
      if (status !== "pending" && status !== "previewing") continue;
      if (entry.preview) {
        entry.preview = null;
        entry.location = null;
        controls.registry.setMark(entry.addresses, "none");
      }
      update(entryId, { status: "stale", returnView: null });
    }
  }

  onCleanup(session.onEdit(onEdit));
  onCleanup(session.onRemoteChange(onRemoteChange));
  // A preview the session ended by itself (an undo with nothing to undo
  // still closes one) leaves its card. The one reactive read is whether a
  // preview is open; the card writes are the apply half's.
  createEffect(
    () => session.previewing(),
    () => reconcile(),
  );

  function decided(entryId: string): boolean {
    if (streamed.card(entryId)) return streamed.decided(entryId);
    const card = cards().get(entryId);
    switch (card?.status) {
      case "applied":
      case "undone":
      case "cancelled":
      case "invalid":
        return true;
      case "stale":
        return card.refreshed;
      default:
        return false;
    }
  }

  function declined(entryId: string): boolean {
    if (streamed.card(entryId)) return streamed.declined(entryId);
    const status = cards().get(entryId)?.status;
    return status === "cancelled" || status === "invalid";
  }

  return {
    card: (entryId) => cards().get(entryId),
    decided,
    declined,
    previewing: () =>
      streamed.previewing() ||
      [...cards().values()].some((card) => card.status === "previewing"),
    receive,
    streamed: (entryId) => streamed.card(entryId),
    receivePart: (entryId, part, origin, baseRevision) =>
      streamed.receivePart(entryId, part, origin, baseRevision),
    endStream: (entryId, ending) => streamed.end(entryId, ending),
    applyPart: (entryId, index) => streamed.applyPart(entryId, index),
    continueRest: (entryId) => streamed.continueRest(entryId),
    preview,
    cancel,
    apply,
    undo,
    refresh,
    reveal: (address) => {
      controls.revealControl(address);
    },
    endPreviews() {
      endWholePreviews();
      streamed.endPreviews();
    },
    remoteChanges: () => remoteChanges,
  };
}

function blankEntry(
  handle: ProposalHandle | null,
  addresses: readonly ControlAddress[],
): Entry {
  return {
    handle,
    addresses,
    preview: null,
    location: null,
    watching: false,
    reported: false,
    marked: false,
  };
}

/**
 * The controls a committed edit changed, read against the project it applied
 * to. Its commands were committed, so every one is registered and valid.
 */
function touchedBy(edit: SessionEdit): ControlAddress[] {
  return uniqueControls(
    edit.commands.flatMap((command) => controlsTouchedBy(command, edit.before)),
  );
}
