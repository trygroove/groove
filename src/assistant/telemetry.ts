/**
 * What the gateway logs about a turn (#69: "minimized logging").
 *
 * One record per turn, made only of codes, counts and durations. It never
 * carries the conversation, the project context, the account's ID or
 * address, the provider's own error text (which can quote the request) or
 * the API key. {@link toTurnLog} builds it field by field from the values the
 * gateway already holds, so nothing reaches a log by being spread in.
 */
import type { AssistantErrorCode, AssistantStopReason } from "./protocol";
import type { ProviderFailureKind } from "./provider";
import type { ProviderUsage } from "./streamEvents";

export interface AssistantTurnLog {
  /** `internal_error`: the turn failed for a reason the gateway does not know. */
  readonly outcome: "completed" | AssistantErrorCode | "internal_error";
  readonly model: string;
  readonly promptVersion: string;
  /** Provider calls made, retries included. */
  readonly attempts: number;
  /** Why each failed attempt failed, in order. */
  readonly failures: readonly ProviderFailureKind[];
  /** The last HTTP status a failed attempt carried, if any. */
  readonly providerStatus: number | null;
  readonly stopReason: AssistantStopReason | null;
  readonly durationMs: number;
  /** Token counts summed over every attempt. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  /** Conversation messages resent, and how many older ones were left out. */
  readonly historySent: number;
  readonly historyDropped: number;
  /**
   * Tutorial videos the reply recommended that were shown, and that were
   * dropped because YouTube could not vouch for them (GRV-16), and how many
   * of the dropped could not be checked at all: those climbing means YouTube
   * is out of reach, while `videosDropped` alone means the IDs were wrong.
   */
  readonly videosShown: number;
  readonly videosDropped: number;
  readonly videosUnchecked: number;
}

/** The keys a turn log may have. A test pins this list. */
export const TURN_LOG_KEYS = [
  "outcome",
  "model",
  "promptVersion",
  "attempts",
  "failures",
  "providerStatus",
  "stopReason",
  "durationMs",
  "inputTokens",
  "outputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "historySent",
  "historyDropped",
  "videosShown",
  "videosDropped",
  "videosUnchecked",
] as const satisfies readonly (keyof AssistantTurnLog)[];

export interface TurnLogInput {
  readonly outcome: AssistantTurnLog["outcome"];
  readonly model: string;
  readonly promptVersion: string;
  readonly failures: readonly { kind: ProviderFailureKind; status: number | null }[];
  readonly attempts: number;
  readonly stopReason: AssistantStopReason | null;
  readonly durationMs: number;
  readonly usage: ProviderUsage;
  readonly historySent: number;
  readonly historyDropped: number;
  readonly videosShown?: number;
  readonly videosDropped?: number;
  readonly videosUnchecked?: number;
}

export function toTurnLog(input: TurnLogInput): AssistantTurnLog {
  const last = input.failures[input.failures.length - 1];
  return {
    outcome: input.outcome,
    model: input.model,
    promptVersion: input.promptVersion,
    attempts: input.attempts,
    failures: input.failures.map((failure) => failure.kind),
    providerStatus: last?.status ?? null,
    stopReason: input.stopReason,
    durationMs: Math.round(input.durationMs),
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    historySent: input.historySent,
    historyDropped: input.historyDropped,
    videosShown: input.videosShown ?? 0,
    videosDropped: input.videosDropped ?? 0,
    videosUnchecked: input.videosUnchecked ?? 0,
  };
}
