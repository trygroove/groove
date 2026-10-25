/**
 * The conversation history resent per turn: what the panel resends
 * ({@link historyOf}), and the bound on it (ADR 0006 decision 3).
 *
 * The provider is stateless, so every turn resends the conversation. Left
 * alone that grows with the session until it overflows the smaller model's
 * window, which would only show the moment the model is swapped. So the
 * oldest messages are dropped until what is sent fits the budget, and the
 * user's newest message is always kept.
 */

import type { LessonId } from "../lessons/ids";
import { type AssistantAsk, askTranscript } from "./ask";
import { ASSISTANT_REQUEST_LIMITS, ESTIMATED_CHARS_PER_TOKEN } from "./config";
import { START_LESSON_TOOL_NAME } from "./lessonTool";
import type { AssistantMessage } from "./protocol";
import { type HistoryTakes, takesNote } from "./takes";
import type { ProposalOutcome } from "./transcripts";

/**
 * What became of the proposal a reply made (GRV-150): one of its outcomes,
 * or `pending` while nobody has applied or cancelled it (and after a reload,
 * which does not bring back its card, so it can no longer be applied).
 */
export type HistoryProposal = ProposalOutcome | "pending";

/** The proposal states a reply can carry, for a schema that keeps them. */
export const HISTORY_PROPOSALS = [
  "pending",
  "applied",
  "cancelled",
  "undone",
  "rejected",
] as const satisfies readonly HistoryProposal[];

/**
 * The line the model reads after a reply that proposed a change, saying what
 * the producer did with it. The reply only says what it proposed, so without
 * it a cancelled track reads like one that exists, and the model trusts the
 * conversation over the project description (GRV-150).
 */
const PROPOSAL_NOTES: Record<HistoryProposal, string> = {
  applied:
    "[The producer applied this proposal. The project description shows the song as it is now.]",
  cancelled: "[The producer cancelled this proposal. Nothing in it is in the song.]",
  undone:
    "[The producer applied this proposal, then undid it. Nothing in it is in the song.]",
  rejected: "[This proposal could not be applied. Nothing in it is in the song.]",
  pending: "[The producer has not applied this proposal. Nothing in it is in the song.]",
};

/** The note for `proposal`, as {@link historyOf} resends it after the reply. */
export function proposalNote(proposal: HistoryProposal): string {
  return PROPOSAL_NOTES[proposal];
}

/**
 * The line the model reads after a reply that started a lesson (GRV-43). The
 * reply only says it is starting one; without the line, a later turn reads
 * that sentence as what started it, and says it again with no call.
 */
export function lessonNote(chapter: LessonId): string {
  return `[I called ${START_LESSON_TOOL_NAME} with chapter "${chapter}", which put the lesson's card in the panel. Saying I'd start one did not start it; only the call did.]`;
}

/** How every bracketed note {@link historyOf} adds to a reply opens (here, `ask.ts`, `takes.ts`). */
const NOTE_OPENING = String.raw`\[(?:I called |I asked the producer|I offered the producer|I recommended |The producer (?:applied|cancelled|has not)|This proposal )`;

/** One such note, or the start of one still arriving at the end of the text. */
const ECHOED_NOTE = new RegExp(`${NOTE_OPENING}[^\\]]*(?:\\]|$)`, "g");

/**
 * `text` without the bracketed notes {@link historyOf} adds after a reply.
 * They are Groove's lines about what a reply did, written as the model would,
 * and a model reading them back sometimes writes one into its own reply
 * instead of making the call it describes (GRV-207: "[I offered the producer
 * 4 takes …]" where `offer_takes` should have been). Such a copy is not shown
 * as something it said, and is not resent as if it had.
 */
export function withoutHistoryNotes(text: string): string {
  if (!text.includes("[")) return text;
  const kept = text.replace(ECHOED_NOTE, "");
  return kept === text ? text : kept.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * What {@link historyOf} reads of one thing in a conversation's log. The
 * panel's `ConversationEntry` is one.
 */
export type HistoryEntry =
  | { readonly kind: "message"; readonly text: string; readonly wire?: string }
  | {
      readonly kind: "reply";
      readonly text: string;
      readonly failed?: boolean;
      readonly ask?: AssistantAsk;
      /** What became of the proposal the reply made, when it made one (GRV-150). */
      readonly proposal?: HistoryProposal;
      /** The lesson the reply started, when it started one (GRV-43). */
      readonly lesson?: LessonId;
      /** The takes the reply offered and what became of them (GRV-207). */
      readonly takes?: HistoryTakes;
    }
  | { readonly kind: "video"; readonly video: { readonly videoId: string } }
  | { readonly kind: "proposal" | "recommendation" | "memory" | "error" | "takes" };

/** The most one message may say, as the gateway counts it. */
export const MAX_MESSAGE_CHARS = ASSISTANT_REQUEST_LIMITS.maxMessageChars;

/**
 * The conversation so far, as the next turn resends it: every message that
 * got a reply, with that reply, and after a reply that proposed a change, a
 * line saying what the producer did with it (GRV-150); a lesson the reply
 * started is said beside it (GRV-43), and so are the takes it offered and
 * what became of them (GRV-207). A message whose turn failed is left out,
 * along with whatever its reply wrote before failing, so the roles always
 * alternate and a broken answer is never passed off as the assistant's; the
 * retry resends the message, and its reply is the one that counts.
 */
export function historyOf(entries: readonly HistoryEntry[]): AssistantMessage[] {
  const history: AssistantMessage[] = [];
  let pending: string | null = null;
  for (const entry of entries) {
    // A video the reply recommended (GRV-16) is part of what it said, by the
    // ID the model itself named, so "more like that" has something to go on.
    const last = history.at(-1);
    if (entry.kind === "video" && pending === null && last?.role === "assistant") {
      history[history.length - 1] = {
        role: "assistant",
        text: `${last.text}\n\n[I recommended the YouTube video ${entry.video.videoId}.]`.slice(
          0,
          MAX_MESSAGE_CHARS,
        ),
      };
      continue;
    }
    if (entry.kind === "message") pending = entry.wire ?? entry.text;
    if (entry.kind !== "reply" || pending === null || entry.failed) continue;
    // A question the reply asked is part of what it said (GRV-42), so the
    // model reads its question back beside the answer.
    // So is a lesson it started (GRV-43), which only its call could start.
    const said = [
      withoutHistoryNotes(entry.text).trim(),
      entry.lesson ? lessonNote(entry.lesson) : "",
      entry.ask ? askTranscript(entry.ask) : "",
      entry.takes ? takesNote(entry.takes) : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (said.length === 0) continue;
    // What became of its proposal follows it (GRV-150), and is never the part
    // a long reply loses.
    const note = entry.proposal ? `\n\n${proposalNote(entry.proposal)}` : "";
    history.push(
      { role: "user", text: pending.slice(0, MAX_MESSAGE_CHARS) },
      { role: "assistant", text: said.slice(0, MAX_MESSAGE_CHARS - note.length) + note },
    );
    pending = null;
  }
  // Room for the new message; whole pairs only, so it still starts with the user.
  const room = ASSISTANT_REQUEST_LIMITS.maxMessages - 1;
  const keep = room - (room % 2);
  return history.length > keep ? history.slice(history.length - keep) : history;
}

/** A conservative token estimate for `text` (see `ESTIMATED_CHARS_PER_TOKEN`). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

/** Per-message overhead the wire format adds around the text. */
const MESSAGE_OVERHEAD_TOKENS = 8;

export interface BoundedHistory {
  readonly messages: readonly AssistantMessage[];
  /** How many of the oldest messages were left out. */
  readonly dropped: number;
}

/**
 * The newest suffix of `messages` that fits `budgetTokens`, starting with a
 * user message (the provider requires the conversation to open with one).
 * Returns no messages at all when even the newest one does not fit; the
 * caller decides what that means.
 */
export function boundHistory(
  messages: readonly AssistantMessage[],
  budgetTokens: number,
): BoundedHistory {
  let used = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(messages[index].text) + MESSAGE_OVERHEAD_TOKENS;
    if (used + cost > budgetTokens) break;
    used += cost;
    start = index;
  }
  while (start < messages.length && messages[start].role !== "user") start += 1;
  return { messages: messages.slice(start), dropped: start };
}
