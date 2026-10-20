/**
 * A turn in steps: the model proposes part of a change, is told what became
 * of each call, and goes on to the next part, until it says the proposal is
 * complete (`gateway.ts`).
 *
 * A turn used to be one provider call whose tool calls were the whole
 * proposal. The model is trained to call a tool, read its result and carry
 * on, so it often stopped at a natural step: notes cleared and none written,
 * tracks made and no clips (GRV-6's evals). Answering each step lets it
 * finish. Nothing is applied between steps: every call is collected, and the
 * browser validates and applies the proposal as one transaction, as before.
 *
 * Each change call is checked against its tool's schema here, so a malformed
 * one is refused back to the model, which can send it again, rather than
 * sinking the whole proposal in the browser. What the gateway cannot check
 * (whether an ID exists in the open project) is still the browser's to refuse.
 *
 * A `recommend_sounds` call is checked for where it is aimed (GRV-129): a
 * track or pad it names must be in the project context or made by a change
 * call earlier in the turn (`recommendationTargets.ts`). One aimed at nothing
 * is refused back to the model, even on the step that would have ended the
 * turn, so it can name the right pad rather than leave the browser a card
 * for a pad that does not exist.
 *
 * Under the `oneResponseProposal` tactic (GRV-142) the model writes a whole
 * proposal's calls in one response, so the step that would end the turn is
 * checked as an answered one is: one with a call that would be refused goes
 * on, so the model can fix it ({@link refusedIn}). A turn then takes at most
 * {@link MAX_CHANGE_STEPS} steps of change calls; a further one is refused
 * back to the model with {@link CHANGE_STEPS_SPENT}. A step straight after one
 * with refused calls is fixing them and does not count.
 */
import { isAskCall } from "./ask";
import { isClipCopy } from "./clipReuse";
import type { ExpandedCall, NoteExpander } from "./compactNotes";
import { isLessonCall } from "./lessonTool";
import { isRememberCall } from "./memory";
import type { AssistantStopReason, AssistantToolCall } from "./protocol";
import type { ProviderToolResultBlock } from "./providerRequest";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import {
  misaimedRecommendation,
  type RecommendationTargets,
  withCreatedTargets,
} from "./recommendationTargets";
import { EXPLAIN_TOOL_NAME, isNeedMoreToolsCall, resolveToolCall } from "./tools";
import { isVideoCall } from "./video";

/** The longest refusal sent back to the model, in characters. */
const MAX_REFUSAL_CHARS = 600;

export const ADDED_RESULT =
  "Added to the proposal. Nothing changes until the producer applies the whole proposal. Go on to the next step; call explain_change once the proposal is complete.";

const NOTED_RESULT = "Noted.";

/**
 * How many steps of change calls a turn may take when the model writes a
 * proposal in one response (`oneResponseProposal`, GRV-142): the response,
 * and one more for a proposal that did not fit. Steps that fix refused calls
 * do not count.
 */
export const MAX_CHANGE_STEPS = 2;

/** What a change call past {@link MAX_CHANGE_STEPS} is told. */
export const CHANGE_STEPS_SPENT = `Refused, not added to the proposal: a proposal takes at most ${MAX_CHANGE_STEPS} responses of changes, and this one has had them. Send no more changes; finish with what the proposal has, calling explain_change for it if you have not.`;

/** The order a change call's new note IDs follow (see {@link addedResult}). */
export type AddedOrder = "given" | "duplicate" | "copy";

const ADDED_ORDER: Record<AddedOrder, string> = {
  given: "in the order you gave them",
  duplicate: "in time order of the notes copied (by start, then ID)",
  copy: "the copied notes in time order (by start, then ID), then your new notes in the order you gave them",
};

/**
 * What a change call that joined the proposal is told: {@link ADDED_RESULT},
 * and the IDs its new notes were given (GRV-131), so a later step can update,
 * remove or duplicate them. They count up from the first, so the first and
 * the last say them all. A placement the gateway gave its ID (`clipReuse`)
 * is told that ID too. With `clipReuse`, the order the IDs follow is not
 * always the order the call gave its notes in: the copies of a
 * `notes_duplicate` the gateway gave IDs (the only way such a call has
 * gateway note IDs) take them in the command's order, by start and then ID;
 * a copied clip's copies take them in that order too, before its new notes.
 */
export function addedResult(
  noteIds: readonly string[],
  placementId?: string,
  order: AddedOrder = "given",
): string {
  const [first] = noteIds;
  const last = noteIds.at(-1);
  const said = [ADDED_RESULT];
  if (first !== undefined && last !== undefined) {
    said.push(
      noteIds.length === 1
        ? `Its note's ID is ${first}.`
        : `Its ${noteIds.length} notes' IDs, ${ADDED_ORDER[order]}, count up from ${first} to ${last}.`,
    );
  }
  if (placementId !== undefined) said.push(`Its placement's ID is ${placementId}.`);
  return said.join(" ");
}

/**
 * Whether `call` changes the song, rather than explaining, asking,
 * recommending, proposing something to remember (GRV-25) or starting a
 * lesson (GRV-43).
 */
export function isChangeCall(call: AssistantToolCall): boolean {
  return (
    call.name !== EXPLAIN_TOOL_NAME &&
    call.name !== RECOMMEND_SOUNDS_TOOL &&
    !isAskCall(call) &&
    !isVideoCall(call) &&
    !isRememberCall(call) &&
    !isLessonCall(call)
  );
}

/**
 * Whether an accepted call is a part of the proposal the browser can show on
 * its own as it arrives (GRV-144): a change call, written out with no
 * refusal, whose input fits its tool. `need_more_tools` changes nothing.
 */
export function isProposalPart(call: AssistantToolCall): boolean {
  if (!isChangeCall(call) || isNeedMoreToolsCall(call)) return false;
  if (call.refusal !== undefined) return false;
  return resolveToolCall(call.name, call.input).ok;
}

/**
 * Whether the turn takes another step after a reply that ended this way. It
 * does when the reply stopped for change calls and did not finish: it asked
 * no question and has not explained the proposal, which the prompt makes its
 * last call.
 */
export function continuesAfter(
  stopReason: AssistantStopReason,
  calls: readonly AssistantToolCall[],
): boolean {
  if (stopReason !== "tool_use") return false;
  if (calls.some((call) => isAskCall(call) || call.name === EXPLAIN_TOOL_NAME)) {
    return false;
  }
  return calls.some(isChangeCall);
}

function refusal(message: string): string {
  const reason =
    message.length > MAX_REFUSAL_CHARS
      ? `${message.slice(0, MAX_REFUSAL_CHARS)}...`
      : message;
  return `Refused, not added to the proposal: ${reason}. Send this call again, corrected.`;
}

/** One step's calls answered: which join the proposal, and what the model is told. */
export interface AnsweredStep {
  readonly kept: readonly AssistantToolCall[];
  readonly results: readonly ProviderToolResultBlock[];
  /** The tracks and pads a recommendation may name after this step. */
  readonly targets: RecommendationTargets;
  /** How many recommendations were refused for naming a track or pad that is not there. */
  readonly misaimed: number;
}

/**
 * The calls of a step the turn does not answer (its last), handed on with
 * their compact notes written out. The note IDs the calls make themselves are
 * held back first, so a note written out in one of them never takes one. A
 * call that cannot be written out, or that makes a note ID already given to
 * a note, goes on as it came with why as its `refusal`, which the browser
 * reports as the reason it refuses the proposal (nothing is left to answer
 * the model with).
 */
export function expandCalls(
  calls: readonly AssistantToolCall[],
  notes: NoteExpander,
): AssistantToolCall[] {
  const refusals = calls.map((call) =>
    isChangeCall(call) ? notes.refuseMintedIds(call) : null,
  );
  notes.reserve(calls.filter((_, index) => refusals[index] === null));
  return calls.map((call, index) => {
    if (!isChangeCall(call)) return call;
    const refused = refusals[index];
    if (refused != null) return { ...call, refusal: refused };
    const expanded = notes.expand(call);
    return expanded.ok ? expanded.call : { ...call, refusal: expanded.message };
  });
}

/**
 * Answers a step the turn continues after: each change call that fits its
 * tool, once its compact notes are written out, joins the proposal written
 * out and is told so; one that does not is refused, with why, and left out. A
 * recommendation aimed at a track or pad that is neither in `targets` nor
 * made by an earlier call is refused the same way. Any other call is noted
 * and kept. Given `refuseChanges`, every change call is refused with it
 * instead, and numbers no notes (GRV-142's limit on steps of changes).
 */
export function answerStep(
  calls: readonly AssistantToolCall[],
  targets: RecommendationTargets,
  notes: NoteExpander,
  options: { readonly refuseChanges?: string } = {},
): AnsweredStep {
  const kept: AssistantToolCall[] = [];
  let known = targets;
  let misaimed = 0;
  const refuse = (call: AssistantToolCall, message: string): ProviderToolResultBlock => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: refusal(message),
    is_error: true,
  });
  const results = calls.map((call): ProviderToolResultBlock => {
    if (call.name === RECOMMEND_SOUNDS_TOOL) {
      const problem = misaimedRecommendation(call, known);
      if (problem) {
        misaimed += 1;
        return refuse(call, problem);
      }
    }
    if (!isChangeCall(call)) {
      kept.push(call);
      return { type: "tool_result", tool_use_id: call.id, content: NOTED_RESULT };
    }
    if (options.refuseChanges !== undefined) {
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: options.refuseChanges,
        is_error: true,
      };
    }
    // A note ID of the model's in the gateway's counter is refused before
    // any of the call's notes is numbered (`compactNotes.ts`).
    const clash = notes.refuseGatewayIds(call);
    const expanded: ExpandedCall =
      clash !== null
        ? { ok: false, message: clash }
        : notes.expand(call, (written) => {
            const resolution = resolveToolCall(written.name, written.input);
            return resolution.ok ? null : resolution.message;
          });
    if (!expanded.ok) return refuse(call, expanded.message);
    kept.push(expanded.call);
    known = withCreatedTargets(known, expanded.call);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: addedResult(
        expanded.noteIds,
        expanded.placementId,
        expanded.call.name === "notes_duplicate"
          ? "duplicate"
          : isClipCopy(call)
            ? "copy"
            : "given",
      ),
    };
  });
  return { kept, results, targets: known, misaimed };
}

/**
 * How many of a step's recommendations name a track or pad that is neither
 * in `targets` nor made by an earlier call of the step: what
 * {@link answerStep} would count, without numbering any notes, so the turn
 * can tell whether the step is its last before answering it.
 */
export function misaimedIn(
  calls: readonly AssistantToolCall[],
  targets: RecommendationTargets,
): number {
  let known = targets;
  let misaimed = 0;
  for (const call of calls) {
    if (misaimedRecommendation(call, known)) misaimed += 1;
    else if (isChangeCall(call)) known = withCreatedTargets(known, call);
  }
  return misaimed;
}

/**
 * Whether a step the turn would have ended on goes on after all: it
 * recommended a sound for a track or pad that is not there, and asked
 * nothing, so the model is told and can aim it again.
 */
export function goesOnToReaim(
  stopReason: AssistantStopReason,
  calls: readonly AssistantToolCall[],
  answered: Pick<AnsweredStep, "misaimed">,
): boolean {
  return goesOnToRefuse(stopReason, calls, answered.misaimed);
}

/**
 * How many of a step's change calls {@link answerStep} would refuse for not
 * fitting their tool, or for a note ID in the gateway's counter, without
 * numbering any of the turn's notes: they are written out in order by a fork
 * of the turn's expander, so a call that builds on one before it (a
 * placement of a clip the step makes, a step string on a track it makes) is
 * judged as {@link answerStep} would judge it.
 */
export function refusedIn(
  calls: readonly AssistantToolCall[],
  notes: NoteExpander,
): number {
  const trial = notes.fork();
  return calls.filter((call) => {
    if (!isChangeCall(call)) return false;
    if (trial.refuseGatewayIds(call) !== null) return true;
    return !trial.expand(call, (written) => {
      const resolution = resolveToolCall(written.name, written.input);
      return resolution.ok ? null : resolution.message;
    }).ok;
  }).length;
}

/**
 * Whether a step the turn would have ended on goes on after all, because
 * `refused` of its calls are told so: it asked nothing, so the model can
 * send them again, or finish without them.
 */
export function goesOnToRefuse(
  stopReason: AssistantStopReason,
  calls: readonly AssistantToolCall[],
  refused: number,
): boolean {
  return stopReason === "tool_use" && refused > 0 && !calls.some(isAskCall);
}
