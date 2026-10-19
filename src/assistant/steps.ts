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
import { createNoteExpander, type ExpandedCall, type NoteExpander } from "./compactNotes";
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
import { EXPLAIN_TOOL_NAME, resolveToolCall } from "./tools";
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

/**
 * What a change call that joined the proposal is told: {@link ADDED_RESULT},
 * and the IDs its new notes were given (GRV-131), so a later step can update,
 * remove or duplicate them. They count up from the first, so the first and
 * the last say them all.
 */
export function addedResult(noteIds: readonly string[]): string {
  const [first] = noteIds;
  const last = noteIds.at(-1);
  if (first === undefined || last === undefined) return ADDED_RESULT;
  const ids =
    noteIds.length === 1
      ? `Its note's ID is ${first}.`
      : `Its ${noteIds.length} notes' IDs, in the order you gave them, count up from ${first} to ${last}.`;
  return `${ADDED_RESULT} ${ids}`;
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
      content: addedResult(expanded.noteIds),
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
 * numbering any of the turn's notes: each is written out by an expander of
 * its own, since whether a call fits does not depend on its notes' IDs.
 */
export function refusedIn(calls: readonly AssistantToolCall[], stem: string): number {
  return calls.filter((call) => {
    if (!isChangeCall(call)) return false;
    const notes = createNoteExpander(stem);
    if (notes.refuseGatewayIds(call) !== null) return true;
    return !notes.expand(call, (written) => {
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
