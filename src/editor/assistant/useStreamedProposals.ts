/**
 * The proposal card of a turn that streams its parts (GRV-144): it fills in
 * part by part while the turn runs, and each part can be applied as soon as
 * it lands.
 *
 * - **Apply** on a part runs it as its own transaction: one history entry,
 *   one revision, and undo removes just that part. It applies to the song as
 *   it is at that moment, while the turn goes on.
 * - A part that **needs** an earlier one (clips on a track the proposal
 *   creates) cannot apply until that part has.
 * - A part goes **stale** once the producer has edited what it touches since
 *   the request was sent, a change made elsewhere has landed, or it no longer
 *   applies; the card then offers Refresh, as a whole proposal does.
 * - **Apply all**, once the turn ends, applies every part not yet applied as
 *   one transaction and one undo step.
 * - **Preview** shows every part not yet applied, uncommitted, and takes in
 *   each new one as it lands.
 * - A turn that **fails** partway leaves the parts it sent applicable; the
 *   card says the rest didn't arrive and offers Try again for the remainder.
 *
 * Nothing here mutates a project itself: parts apply through the editor
 * session (`ProposalTarget`), and the preview is the session's.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import type { ProposalTarget } from "../../assistant/proposalExecutor";
import type { AssistantProposal, AssistantProposalPart } from "../../assistant/protocol";
import {
  type AssistantCapability,
  EXPLAIN_TOOL_NAME,
  proposalCapability,
  proposalExplanationSchema,
} from "../../assistant/tools";
import type { ProposalOutcome } from "../../assistant/transcripts";
import {
  type ControlAddress,
  controlKey,
  uniqueControls,
} from "../../commands/controlAddress";
import { controlsTouchedBy } from "../../commands/controls";
import { createCorrelationId } from "../../commands/execute";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import { type Clock, systemClock } from "../../shared/clock";
import type { SessionEdit } from "../EditorSession";
import type { EditorControls, EditorLocation } from "../editorControls";
import type { EditorViewName } from "../editorViews";
import type { Preview } from "../sessionPreview";
import {
  type ProposalExplanation,
  type ProposalRow,
  previewTarget,
  proposalRows,
} from "./proposalCardModel";
import {
  applyCommands,
  type PartResolution,
  partLineText,
  partNeeds,
  type ResolvedPart,
  resolvePart,
} from "./proposalParts";
import type { TurnOrigin } from "./useAssistantConversation";
import type { ProposalSessionPort } from "./useAssistantProposals";

/**
 * - `ready`: it can be applied now.
 * - `blocked`: it needs an earlier part applied first.
 * - `applied`: committed, as its own undo step or in Apply all's.
 * - `stale`: the song changed under it; it cannot be applied as it is.
 * - `invalid`: it does not fit the song at all.
 */
export type StreamedPartStatus = "ready" | "blocked" | "applied" | "stale" | "invalid";

/** One part's line on the card. */
export interface StreamedPartLine {
  readonly index: number;
  /** "Kick · 4 bars", or "Swing 50% to 58%", as it reads aloud. */
  readonly text: string;
  /** The controls it changes, old to new, when its line lists those (`PartLine.rows`). */
  readonly rows: readonly ProposalRow[];
  readonly status: StreamedPartStatus;
  /** For a blocked part: what it needs, as "Needs … first" names it. */
  readonly needs: string | null;
  /** For an invalid part: why, in plain words. */
  readonly reason: string | null;
}

/**
 * - `running`: the turn is still writing.
 * - `ended`: it finished.
 * - `stopped`: the producer stopped it.
 * - `failed`: it failed partway; the rest never arrived.
 */
export type StreamedTurn = "running" | "ended" | "stopped" | "failed";

/** Everything a streamed card shows. */
export interface StreamedProposalCard {
  readonly title: string;
  readonly scopeLabel: string;
  readonly parts: readonly StreamedPartLine[];
  readonly turn: StreamedTurn;
  /** `open` until it is cancelled; `previewing` while its preview is. */
  readonly status: "open" | "previewing" | "cancelled";
  /** Whether Apply all would apply the rest now. */
  readonly canApplyAll: boolean;
  /** Whether the card's newest applied step is the session's newest. */
  readonly canUndo: boolean;
  /** Whether the newest step this card applied was Apply all's. */
  readonly appliedAll: boolean;
  readonly refreshed: boolean;
  /** Whether Try again has asked for the rest. */
  readonly continued: boolean;
  readonly explanation: ProposalExplanation | null;
  readonly previewView: EditorViewName | null;
  readonly returnView: EditorViewName | null;
  readonly outlined: boolean;
  readonly notice: string | null;
}

export interface UseStreamedProposalsOptions {
  readonly session: ProposalSessionPort;
  readonly controls: Pick<EditorControls, "registry" | "revealControl" | "restoreView">;
  readonly project: Accessor<Project | null>;
  readonly analytics: () => Analytics;
  readonly clock?: Clock;
  /** Asks again, in the same scope, for the proposal in this entry. */
  refresh(entryId: string): boolean;
  /** Asks for the rest of a proposal whose turn failed partway. */
  continueRest(entryId: string): boolean;
  /** A streamed card's preview is opening: any other card's must end. */
  onPreviewOpen(): void;
  onOutcome?(entryId: string, outcome: ProposalOutcome): void;
}

export interface StreamedProposals {
  /** The card for an entry, if it is a streamed one. Reactive. */
  card(entryId: string): StreamedProposalCard | undefined;
  /** Whether an entry is a streamed card. Not reactive. */
  has(entryId: string): boolean;
  /**
   * A part arrived: check it against the song and add its line. `baseRevision`
   * is the revision the turn was sent against: an edit since then to what a
   * part touches makes it stale.
   */
  receivePart(
    entryId: string,
    part: AssistantProposalPart,
    origin: TurnOrigin,
    baseRevision: number,
  ): void;
  /** The whole proposal arrived at the end of the turn: its explanation. */
  finish(entryId: string, proposal: AssistantProposal): void;
  /**
   * Lets go of a card none of whose parts fit the song and none applied, so
   * the whole proposal can be shown as one that does not fit, saying why
   * (GRV-98). Returns whether it did.
   */
  releaseRefused(entryId: string): boolean;
  /** The turn ended, one way or another. */
  end(entryId: string, turn: Exclude<StreamedTurn, "running">): void;
  applyPart(entryId: string, index: number): void;
  applyAll(entryId: string): void;
  preview(entryId: string): void;
  cancel(entryId: string): void;
  undo(entryId: string): void;
  refresh(entryId: string): void;
  continueRest(entryId: string): void;
  decided(entryId: string): boolean;
  declined(entryId: string): boolean;
  /** Whether any streamed card is previewing. Reactive. */
  readonly previewing: Accessor<boolean>;
  /** Another card's preview opened: end every one of these. */
  endPreviews(): void;
}

interface PartState {
  readonly index: number;
  readonly resolution: PartResolution;
  /** The earlier parts it needs applied first. */
  readonly needs: readonly number[];
  /** The controls it changes, read against the project it applies to. */
  readonly controls: readonly ControlAddress[];
  readonly keys: ReadonlySet<string>;
  /** The correlation ID of the step that applied it, while it stays applied. */
  appliedBy: string | null;
}

interface StreamState {
  readonly origin: TurnOrigin;
  /** The revision the request was built against. */
  readonly baseRevision: number;
  readonly parts: PartState[];
  turn: StreamedTurn;
  status: "open" | "previewing" | "cancelled";
  explanation: ProposalExplanation | null;
  refreshed: boolean;
  continued: boolean;
  /** Each step this card applied, oldest first: its correlation ID and parts. */
  readonly steps: { readonly id: string; readonly parts: readonly number[] }[];
  preview: Preview | null;
  location: EditorLocation | null;
  previewView: EditorViewName | null;
  /** The controls wearing the solid outline since its last apply. */
  marked: readonly ControlAddress[];
  notice: string | null;
  /** When the turn ended, for the decision time Apply all logs. */
  endedAt: number | null;
}

/** An edit made other than through a streamed card, and what it touched. */
interface ForeignEdit {
  /** The committed revision it was made on. */
  readonly revision: number;
  readonly keys: ReadonlySet<string>;
}

/** How many foreign edits are remembered, newest kept. */
const MAX_FOREIGN_EDITS = 500;

const BUSY = "Finish the change you're making first, then try again.";
const CANNOT_UNDO =
  "Something else changed after it, so undo it from the header's Undo instead.";

export function useStreamedProposals(
  options: UseStreamedProposalsOptions,
): StreamedProposals {
  const { session, controls } = options;
  const clock = options.clock ?? systemClock;
  const states = new Map<string, StreamState>();
  const foreign: ForeignEdit[] = [];
  let remoteChanges = 0;
  const [cards, setCards] = createSignal<ReadonlyMap<string, StreamedProposalCard>>(
    new Map(),
  );

  function target(): ProposalTarget {
    const current = session.proposalTarget();
    if (!current) throw new Error("The assistant's proposal has no open project");
    return current;
  }
  const committed = (): Project | null => session.proposalTarget()?.project ?? null;

  function resolved(part: PartState): ResolvedPart | null {
    return part.resolution.ok ? part.resolution : null;
  }

  /** Whether the song moved under a part that has not applied. */
  function staleUnder(state: StreamState, part: PartState): boolean {
    if (remoteChanges !== state.origin.remoteChanges) return true;
    return foreign.some(
      (edit) =>
        edit.revision >= state.baseRevision &&
        [...part.keys].some((key) => edit.keys.has(key)),
    );
  }

  function statusOf(
    state: StreamState,
    part: PartState,
    project: Project,
  ): { status: StreamedPartStatus; needs: number | null } {
    const resolution = resolved(part);
    if (!resolution) return { status: "invalid", needs: null };
    if (part.appliedBy) return { status: "applied", needs: null };
    const waiting = part.needs.find((index) => !state.parts[index]?.appliedBy);
    if (waiting !== undefined) return { status: "blocked", needs: waiting };
    if (staleUnder(state, part) || !applyCommands(project, [resolution.command])) {
      return { status: "stale", needs: null };
    }
    return { status: "ready", needs: null };
  }

  /** The parts not applied yet that can join a preview or Apply all, in order. */
  function rest(state: StreamState): { part: PartState; command: RawCommandInput }[] {
    return state.parts.flatMap((part) => {
      const resolution = resolved(part);
      return resolution && !part.appliedBy ? [{ part, command: resolution.command }] : [];
    });
  }

  function canApplyAll(state: StreamState, project: Project): boolean {
    if (state.turn === "running" || state.status === "cancelled") return false;
    if (state.parts.some((part) => !part.resolution.ok && !part.appliedBy)) return false;
    const remaining = rest(state);
    if (remaining.length === 0) return false;
    if (remaining.some(({ part }) => staleUnder(state, part))) return false;
    return (
      applyCommands(
        project,
        remaining.map(({ command }) => command),
      ) !== null
    );
  }

  function snapshot(state: StreamState): StreamedProposalCard {
    const project = committed();
    const parts = state.parts.map((part): StreamedPartLine => {
      const { status, needs } = project
        ? statusOf(state, part, project)
        : { status: "stale" as const, needs: null };
      const needed = needs === null ? null : state.parts[needs];
      return {
        index: part.index,
        text: part.resolution.ok ? partLineText(part.resolution.line) : "A change",
        rows: part.resolution.ok ? part.resolution.line.rows : [],
        status,
        needs: needed ? neededName(needed) : null,
        reason: part.resolution.ok ? null : part.resolution.reason,
      };
    });
    const newest = newestApplied(state);
    return {
      title: state.origin.text,
      scopeLabel: state.origin.scope.label,
      parts,
      turn: state.turn,
      status: state.status,
      canApplyAll: project ? canApplyAll(state, project) : false,
      canUndo:
        newest !== undefined &&
        session.proposalTarget()?.latestCorrelationId === newest.id,
      appliedAll: (newest?.parts.length ?? 0) > 1,
      refreshed: state.refreshed,
      continued: state.continued,
      explanation: state.explanation,
      previewView: state.previewView,
      returnView: state.location?.view ?? null,
      outlined: state.marked.length > 0,
      notice: state.notice,
    };
  }

  function publish() {
    setCards(new Map([...states].map(([entryId, state]) => [entryId, snapshot(state)])));
  }

  function receivePart(
    entryId: string,
    part: AssistantProposalPart,
    origin: TurnOrigin,
    baseRevision: number,
  ) {
    const project = committed();
    if (!project) return;
    let state = states.get(entryId);
    if (!state) {
      state = {
        origin,
        baseRevision,
        parts: [],
        turn: "running",
        status: "open",
        explanation: null,
        refreshed: false,
        continued: false,
        steps: [],
        preview: null,
        location: null,
        previewView: null,
        marked: [],
        notice: null,
        endedAt: null,
      };
      states.set(entryId, state);
      if (origin.sentAt !== undefined) {
        options.analytics().log("assistant_proposal_first_part_shown", {
          elapsed_ms_bucket: bucketOf("elapsed_ms", clock.now() - origin.sentAt),
        });
      }
    }
    if (state.status === "cancelled") return;
    // Checked against the song as it would be with every earlier part that
    // has not applied yet on top: that is what it is written against.
    const working =
      applyCommands(
        project,
        rest(state).map(({ command }) => command),
      ) ?? project;
    const resolution = resolvePart(working, part);
    const controls = resolution.ok ? resolution.proposal.impact.controls : [];
    state.parts.push({
      index: state.parts.length,
      resolution,
      needs: resolution.ok
        ? partNeeds(
            resolution.command,
            state.parts.flatMap((earlier) =>
              earlier.resolution.ok
                ? [{ index: earlier.index, creates: earlier.resolution.creates }]
                : [],
            ),
          )
        : [],
      controls,
      keys: new Set(controls.map(controlKey)),
      appliedBy: null,
    });
    // An open preview takes the new part in.
    if (state.preview) reopenPreview(state);
    publish();
  }

  function finish(entryId: string, proposal: AssistantProposal) {
    const state = states.get(entryId);
    const project = committed();
    if (!state || !project) return;
    const explained = proposal.calls.find((call) => call.name === EXPLAIN_TOOL_NAME);
    const parsed = explained
      ? proposalExplanationSchema.safeParse(explained.input)
      : null;
    if (parsed?.success) {
      const addresses = uniqueControls(state.parts.flatMap((part) => part.controls));
      const after =
        applyCommands(
          project,
          rest(state).map(({ command }) => command),
        ) ?? project;
      state.explanation = {
        goal: parsed.data.goal,
        technique: parsed.data.technique,
        changed: proposalRows(project, after, addresses),
      };
    }
    publish();
  }

  function releaseRefused(entryId: string): boolean {
    const state = states.get(entryId);
    if (!state || state.parts.some((part) => part.resolution.ok || part.appliedBy)) {
      return false;
    }
    if (state.preview) endPreview(state);
    states.delete(entryId);
    publish();
    return true;
  }

  function end(entryId: string, turn: Exclude<StreamedTurn, "running">) {
    const state = states.get(entryId);
    if (!state || state.turn !== "running") return;
    state.turn = turn;
    state.endedAt = clock.now();
    const capabilities = capabilitiesOf(state);
    if (capabilities.length > 0) {
      options.analytics().log("assistant_proposal_shown", {
        capability: proposalCapability(capabilities),
        command_count_bucket: bucketOf("command_count", capabilities.length),
      });
    }
    publish();
  }

  /** Runs `commands` as one step of this card's: one transaction, one undo entry. */
  function run(
    entryId: string,
    state: StreamState,
    parts: readonly number[],
    commands: readonly RawCommandInput[],
  ): boolean {
    const current = target();
    if (current.gestureActive) {
      state.notice = BUSY;
      publish();
      return false;
    }
    const wasPreviewing = state.preview !== null;
    if (state.preview) endPreview(state);
    if (wasPreviewing) state.status = "open";
    const id = createCorrelationId("asp");
    state.steps.push({ id, parts });
    const result = current.execute(commands, { actor: "assistant", correlationId: id });
    if (!result.ok) {
      state.steps.pop();
      state.notice = null;
      publish();
      return false;
    }
    for (const index of parts) {
      const part = state.parts[index];
      if (part) part.appliedBy = id;
    }
    state.notice = null;
    clearMarks();
    state.marked = uniqueControls(
      parts.flatMap((index) => state.parts[index]?.controls ?? []),
    );
    controls.registry.setMark(state.marked, "changed");
    // A preview stays on while there is more to show.
    if (!wasPreviewing || !openPreview(state, false)) {
      state.status = "open";
      state.location = null;
    }
    options.onOutcome?.(entryId, "applied");
    publish();
    return true;
  }

  function applyPart(entryId: string, index: number) {
    const state = states.get(entryId);
    const part = state?.parts[index];
    const project = committed();
    if (!state || !part || !project || state.status === "cancelled") return;
    const resolution = resolved(part);
    if (!resolution || statusOf(state, part, project).status !== "ready") {
      publish();
      return;
    }
    const running = state.turn === "running";
    if (!run(entryId, state, [index], [resolution.command])) return;
    const analytics = options.analytics();
    analytics.log("assistant_proposal_part_applied", {
      part_index: index,
      turn_running: running,
    });
    analytics.logFeatureFirstUse("assistant_proposal_part");
  }

  function applyAll(entryId: string) {
    const state = states.get(entryId);
    const project = committed();
    if (!state || !project || !canApplyAll(state, project)) return;
    const remaining = rest(state);
    const applied = run(
      entryId,
      state,
      remaining.map(({ part }) => part.index),
      remaining.map(({ command }) => command),
    );
    if (!applied) return;
    const capabilities = remaining.flatMap(({ part }) =>
      part.resolution.ok ? part.resolution.proposal.capabilities : [],
    );
    const analytics = options.analytics();
    analytics.log("assistant_proposal_applied", {
      capability: proposalCapability(capabilities),
      command_count_bucket: bucketOf("command_count", remaining.length),
      seconds_to_decision_bucket: bucketOf(
        "elapsed_seconds",
        (clock.now() - (state.endedAt ?? clock.now())) / 1000,
      ),
    });
    analytics.logFeatureFirstUse("assistant_proposal");
  }

  /** Opens the preview of every part not applied yet. */
  function openPreview(state: StreamState, reveal: boolean): boolean {
    const project = committed();
    if (!project) return false;
    // Each part in order, those that no longer apply left out.
    let working = project;
    const commands: RawCommandInput[] = [];
    const addresses: ControlAddress[] = [];
    for (const { part, command } of rest(state)) {
      const next = applyCommands(working, [command]);
      if (!next) continue;
      working = next;
      commands.push(command);
      addresses.push(...part.controls);
    }
    if (commands.length === 0) return false;
    const opened = session.beginPreview(commands);
    if (!opened?.ok) {
      state.notice = BUSY;
      return false;
    }
    state.preview = opened.preview;
    state.status = "previewing";
    const marked = uniqueControls(addresses);
    controls.registry.setMark(marked, "previewed");
    if (reveal) {
      const rows = proposalRows(project, working, marked);
      const shown = previewTarget(project, rows);
      state.previewView = shown?.view ?? null;
      const from = shown ? controls.revealControl(shown.address, { focus: false }) : null;
      state.location ??= from;
    }
    return true;
  }

  /** The preview again, with the parts as they now stand. */
  function reopenPreview(state: StreamState) {
    const location = state.location;
    endPreview(state);
    state.location = location;
    if (!openPreview(state, false)) {
      state.status = "open";
      state.location = null;
    }
  }

  function endPreview(state: StreamState) {
    const open = state.preview;
    state.preview = null;
    const addresses = uniqueControls(state.parts.flatMap((part) => part.controls));
    controls.registry.setMark(addresses, "none");
    if (state.marked.length > 0) controls.registry.setMark(state.marked, "changed");
    open?.cancel();
  }

  function endPreviews() {
    let changed = false;
    for (const state of states.values()) {
      if (!state.preview) continue;
      endPreview(state);
      state.status = "open";
      changed = true;
    }
    if (changed) publish();
  }

  function preview(entryId: string) {
    const state = states.get(entryId);
    if (!state || state.status !== "open") return;
    // One preview at a time, across every card.
    let location: EditorLocation | null = null;
    for (const other of states.values()) {
      if (other === state || !other.preview) continue;
      location = other.location;
      endPreview(other);
      other.status = "open";
      other.location = null;
    }
    options.onPreviewOpen();
    state.location = location;
    state.notice = null;
    if (!openPreview(state, true)) {
      state.location = null;
      publish();
      return;
    }
    options.analytics().logFeatureFirstUse("assistant_proposal");
    publish();
  }

  function cancel(entryId: string) {
    const state = states.get(entryId);
    if (!state || state.status === "cancelled") return;
    if (state.status === "previewing") {
      const location = state.location;
      endPreview(state);
      state.status = "open";
      state.location = null;
      if (location) controls.restoreView(location);
      publish();
      return;
    }
    state.status = "cancelled";
    if (!state.parts.some((part) => part.appliedBy)) {
      const capabilities = capabilitiesOf(state);
      if (capabilities.length > 0) {
        options.analytics().log("assistant_proposal_cancelled", {
          capability: proposalCapability(capabilities),
          command_count_bucket: bucketOf("command_count", capabilities.length),
          seconds_to_decision_bucket: bucketOf(
            "elapsed_seconds",
            (clock.now() - (state.endedAt ?? clock.now())) / 1000,
          ),
        });
      }
    }
    options.onOutcome?.(entryId, "cancelled");
    publish();
  }

  function undo(entryId: string) {
    const state = states.get(entryId);
    const newest = state && newestApplied(state);
    if (!state || !newest) return;
    const current = target();
    if (current.gestureActive) {
      state.notice = BUSY;
      publish();
      return;
    }
    if (current.latestCorrelationId !== newest.id || !current.undo()) {
      state.notice = CANNOT_UNDO;
      publish();
    }
    // The session reports the undo, which is what un-applies the parts.
  }

  function refresh(entryId: string) {
    const state = states.get(entryId);
    if (!state || state.refreshed) return;
    if (options.refresh(entryId)) {
      state.refreshed = true;
      publish();
    }
  }

  function continueRest(entryId: string) {
    const state = states.get(entryId);
    if (!state || state.turn !== "failed" || state.continued) return;
    if (options.continueRest(entryId)) {
      state.continued = true;
      publish();
    }
  }

  /** The step a session edit replays, and the card it belongs to. */
  function ownStep(correlationId: string) {
    for (const [entryId, state] of states) {
      const step = state.steps.find((candidate) => candidate.id === correlationId);
      if (step) return { entryId, state, step };
    }
    return null;
  }

  function clearMarks() {
    for (const state of states.values()) {
      if (state.marked.length === 0) continue;
      if (!state.preview) controls.registry.setMark(state.marked, "none");
      state.marked = [];
    }
  }

  function onEdit(edit: SessionEdit) {
    const own = ownStep(edit.correlationId);
    if (own) {
      const { entryId, state, step } = own;
      if (edit.kind === "undo") {
        for (const index of step.parts) {
          const part = state.parts[index];
          if (part?.appliedBy === step.id) part.appliedBy = null;
        }
        clearMarks();
        if (!state.parts.some((part) => part.appliedBy)) {
          options.onOutcome?.(entryId, "undone");
        }
      } else if (edit.kind === "redo") {
        for (const index of step.parts) {
          const part = state.parts[index];
          if (part) part.appliedBy = step.id;
        }
        options.onOutcome?.(entryId, "applied");
      }
    } else {
      // Anything else that changed the song: another card, or the producer.
      foreign.push({
        revision: edit.before.metadata.revision,
        keys: new Set(touchedBy(edit).map(controlKey)),
      });
      if (foreign.length > MAX_FOREIGN_EDITS) foreign.shift();
      if (edit.kind === "edit") clearMarks();
    }
    reconcile();
    publish();
  }

  /** A preview the session ended by itself leaves its card. */
  function reconcile() {
    for (const state of states.values()) {
      if (!state.preview || state.preview.status === "open") continue;
      state.preview = null;
      state.location = null;
      state.status = "open";
      const addresses = uniqueControls(state.parts.flatMap((part) => part.controls));
      controls.registry.setMark(addresses, "none");
    }
  }

  function onRemoteChange() {
    remoteChanges += 1;
    for (const state of states.values()) {
      if (!state.preview) continue;
      state.preview = null;
      state.location = null;
      state.status = "open";
    }
    publish();
  }

  onCleanup(session.onEdit(onEdit));
  onCleanup(session.onRemoteChange(onRemoteChange));
  createEffect(
    () => session.previewing(),
    () => {
      if (states.size === 0) return;
      reconcile();
      publish();
    },
  );

  function decided(entryId: string): boolean {
    const card = cards().get(entryId);
    if (!card) return false;
    if (card.status === "cancelled" || card.refreshed || card.continued) return true;
    return (
      card.turn !== "running" &&
      card.parts.every(
        (part) => part.status === "applied" || part.status === "invalid",
      ) &&
      card.parts.some((part) => part.status === "applied")
    );
  }

  return {
    card: (entryId) => cards().get(entryId),
    has: (entryId) => states.has(entryId),
    receivePart,
    finish,
    releaseRefused,
    end,
    applyPart,
    applyAll,
    preview,
    cancel,
    undo,
    refresh,
    continueRest,
    decided,
    declined: (entryId) => cards().get(entryId)?.status === "cancelled",
    previewing: () => [...cards().values()].some((card) => card.status === "previewing"),
    endPreviews,
  };
}

/** The newest step of the card's that is still applied. */
function newestApplied(state: StreamState) {
  return state.steps.findLast((step) =>
    step.parts.some((index) => state.parts[index]?.appliedBy === step.id),
  );
}

/** What a part needs, as "Needs … first" names it: a track by its name, anything else by its line. */
function neededName(part: PartState): string {
  if (!part.resolution.ok) return "an earlier part";
  const { line } = part.resolution;
  return line.detail === "new track" ? line.name : partLineText(line);
}

function capabilitiesOf(state: StreamState): AssistantCapability[] {
  return state.parts.flatMap((part) =>
    part.resolution.ok ? part.resolution.proposal.capabilities : [],
  );
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
