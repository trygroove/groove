/**
 * What an inline error in the conversation says (GRV-26): which failure it
 * was, in plain words, and for a quota when it resets (ADR 0006 decision 5).
 * Every one is followed by the same reassurance, because none of them
 * touches the song.
 */
import type { AssistantErrorDetails } from "../../assistant/protocol";

/** The heading every inline error shares. */
export const ERROR_HEADING = "The assistant couldn't reply.";

/** The line under every failure's own words. */
export const ERROR_REASSURANCE = "Your song is unchanged, and editing still works.";

/**
 * When a reset happens, as the end of a sentence: "at 14:05", "tomorrow at
 * 14:05", or with its date when it is further off than that.
 */
export function resetTime(resetsAt: number, now: Date, locale?: string): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const dayOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const date = at.toLocaleDateString(locale, { day: "numeric", month: "short" });
  return `on ${date} at ${time}`;
}

/** What went wrong, in one plain sentence. */
export function errorMessage(
  error: AssistantErrorDetails,
  now: Date = new Date(),
  locale?: string,
): string {
  switch (error.code) {
    case "timeout":
      return "It took too long to answer.";
    case "provider_unavailable":
      return "Its model is busy or can't be reached right now.";
    case "provider_error":
      return "Its model refused the request.";
    case "malformed_response":
      return "Its reply came back broken.";
    case "reply_too_long":
      return "Its reply ran out of room before it finished. Try asking for a smaller change.";
    case "quota_exceeded":
      return error.resetsAt === undefined
        ? "You've used all your assistant requests for the last 24 hours."
        : `You've used all your assistant requests for the last 24 hours. The next one frees up ${resetTime(error.resetsAt, now, locale)}.`;
    case "assistant_disabled":
      return "The assistant is switched off for now.";
    case "spend_ceiling_reached":
      return "The assistant has reached today's limit for everyone. It will be back tomorrow.";
    case "unauthenticated":
      return "Sign in to use the assistant.";
    case "invalid_request":
      return "That message, or what's in scope, is too large for it to read.";
    case "cancelled":
      return "The request was cancelled.";
  }
}
