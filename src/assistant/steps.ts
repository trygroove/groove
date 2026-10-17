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
 */
import { isAskCall } from "./ask";
import type { ExpandedCall, NoteExpander } from "./compactNotes";
import { isRememberCall } from "./memory";
import type { AssistantStopReason, AssistantToolCall } from "./protocol";
import type { ProviderToolResultBlock } from "./providerRequest";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { EXPLAIN_TOOL_NAME, resolveToolCall } from "./tools";
import { isVideoCall } from "./video";

/** The longest refusal sent back to the model, in characters. */
const MAX_REFUSAL_CHARS = 600;

export const ADDED_RESULT =
  "Added to the proposal. Nothing changes until the producer applies the whole proposal. Go on to the next step; call explain_change once the proposal is complete.";

const NOTED_RESULT = "Noted.";

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
 * out and is told so; one that does not is refused, with why, and left out.
 * Any other call is noted and kept.
 */
export function answerStep(
  calls: readonly AssistantToolCall[],
  notes: NoteExpander,
): AnsweredStep {
  const kept: AssistantToolCall[] = [];
  const results = calls.map((call): ProviderToolResultBlock => {
    if (!isChangeCall(call)) {
      kept.push(call);
      return { type: "tool_result", tool_use_id: call.id, content: NOTED_RESULT };
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
    if (!expanded.ok) {
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: refusal(expanded.message),
        is_error: true,
      };
    }
    kept.push(expanded.call);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: addedResult(expanded.noteIds),
    };
  });
  return { kept, results };
}
