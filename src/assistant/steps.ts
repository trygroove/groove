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
 */
import { isAskCall } from "./ask";
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
 * Whether `call` changes the song, rather than explaining, asking,
 * recommending or proposing something to remember (GRV-25).
 */
function isChangeCall(call: AssistantToolCall): boolean {
  return (
    call.name !== EXPLAIN_TOOL_NAME &&
    call.name !== RECOMMEND_SOUNDS_TOOL &&
    !isAskCall(call) &&
    !isVideoCall(call) &&
    !isRememberCall(call)
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
 * Answers a step: each change call that fits its tool joins the proposal and
 * is told so; one that does not is refused, with why, and left out. A
 * recommendation aimed at a track or pad that is neither in `targets` nor
 * made by an earlier call is refused the same way. Any other call is noted
 * and kept.
 */
export function answerStep(
  calls: readonly AssistantToolCall[],
  targets: RecommendationTargets,
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
    const resolution = resolveToolCall(call.name, call.input);
    if (!resolution.ok) return refuse(call, resolution.message);
    kept.push(call);
    known = withCreatedTargets(known, call);
    return { type: "tool_result", tool_use_id: call.id, content: ADDED_RESULT };
  });
  return { kept, results, targets: known, misaimed };
}

/**
 * Whether a step the turn would have ended on goes on after all: it
 * recommended a sound for a track or pad that is not there, and asked
 * nothing, so the model is told and can aim it again.
 */
export function goesOnToReaim(
  stopReason: AssistantStopReason,
  calls: readonly AssistantToolCall[],
  answered: AnsweredStep,
): boolean {
  return stopReason === "tool_use" && answered.misaimed > 0 && !calls.some(isAskCall);
}
