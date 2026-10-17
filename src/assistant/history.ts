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
import { type AssistantAsk, askTranscript } from "./ask";
import { ASSISTANT_REQUEST_LIMITS, ESTIMATED_CHARS_PER_TOKEN } from "./config";
import type { AssistantMessage } from "./protocol";

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
    }
  | { readonly kind: "video"; readonly video: { readonly videoId: string } }
  | { readonly kind: "proposal" | "recommendation" | "memory" | "error" };

/** The most one message may say, as the gateway counts it. */
export const MAX_MESSAGE_CHARS = ASSISTANT_REQUEST_LIMITS.maxMessageChars;

/**
 * The conversation so far, as the next turn resends it: every message that
 * got a reply, with that reply. A message whose turn failed is left out,
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
    const said = [entry.text.trim(), entry.ask ? askTranscript(entry.ask) : ""]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (said.length === 0) continue;
    history.push(
      { role: "user", text: pending.slice(0, MAX_MESSAGE_CHARS) },
      { role: "assistant", text: said.slice(0, MAX_MESSAGE_CHARS) },
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
