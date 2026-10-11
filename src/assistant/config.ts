/**
 * The assistant gateway's configuration (#69, ADR 0006 decisions 2 and 7).
 *
 * Every number the gateway, its limits and the copy that describes them need
 * is written down here and nowhere else: which model answers, how each model
 * wants its request shaped, how long one provider call may take, how often a
 * failed one is retried, and how much conversation is resent per turn.
 * Switching models is a change to {@link ASSISTANT_MODEL_ID} and nothing else
 * (ADR 0006 decision 2: the product owner's call, from dogfooding).
 *
 * Like `src/domain`, this module imports nothing from Firebase, Tone or Solid,
 * and nothing from the provider's SDK: the Cloud Function
 * (`functions/src/index.ts`, over `functions/src/assistantHandler.ts` and
 * `functions/src/anthropicProvider.ts`) is the only place that touches either.
 */

/**
 * How a model wants extended thinking asked for. The models under evaluation
 * do not take the same request (ADR 0006 decision 3):
 *
 * - `adaptive`: `thinking: { type: "adaptive" }` with the depth set by
 *   `output_config.effort`. Claude Sonnet 5.
 * - `budget`: `thinking: { type: "enabled", budget_tokens }`, and **no**
 *   `effort`, which this model rejects. Claude Haiku 4.5.
 */
export type ThinkingShape =
  | { readonly kind: "adaptive"; readonly effort: "low" | "medium" | "high" }
  | { readonly kind: "budget"; readonly budgetTokens: number };

/** One model the gateway can be pointed at, and the request it takes. */
export interface AssistantModelProfile {
  /** The provider's model ID, sent verbatim. */
  readonly id: string;
  /** The model's context window, in tokens. */
  readonly contextWindowTokens: number;
  /** The most the gateway lets one reply run to, thinking included. */
  readonly maxOutputTokens: number;
  readonly thinking: ThinkingShape;
  /**
   * What the provider charges, in US dollars per million tokens, for the
   * spend ceiling's running total. Cache writes and reads are billed apart
   * from plain input.
   */
  readonly priceUsdPerMillionTokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheWrite: number;
    readonly cacheRead: number;
  };
}

/**
 * Every model the gateway is configured to call. A model missing from here
 * cannot be selected, so a request shape is never guessed.
 */
export const ASSISTANT_MODELS = {
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_000,
    thinking: { kind: "adaptive", effort: "medium" },
    priceUsdPerMillionTokens: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_000,
    thinking: { kind: "budget", budgetTokens: 4_096 },
    priceUsdPerMillionTokens: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  },
} as const satisfies Record<string, AssistantModelProfile>;

export type AssistantModelId = keyof typeof ASSISTANT_MODELS;

/** The model the alpha answers with (ADR 0006 decision 2). */
export const ASSISTANT_MODEL_ID: AssistantModelId = "claude-sonnet-5";

/**
 * The smallest context window among the configured models. The resent history
 * is bounded to fit this one, not the active model's, so swapping to the
 * smaller model can never be the change that overflows a long conversation
 * (ADR 0006 decision 3).
 */
export const SMALLEST_CONTEXT_WINDOW_TOKENS = Math.min(
  ...Object.values(ASSISTANT_MODELS).map((model) => model.contextWindowTokens),
);

/**
 * The name of the Secret Manager secret that holds the provider's API key. It
 * is bound to the Cloud Function only, so the key never reaches a browser, a
 * log line or project state.
 */
export const ASSISTANT_API_KEY_SECRET = "ANTHROPIC_API_KEY";

/** The name the browser calls the gateway by (a callable Cloud Function). */
export const ASSISTANT_CALLABLE_NAME = "assistantTurn";

/**
 * Limits on one turn's provider calls.
 *
 * - `inactivityTimeoutMs`: how long one provider call may go without sending
 *   anything (an event, a ping) before it is abandoned as a `timeout`. An
 *   inactivity limit, not a total one, so a long reply that keeps streaming
 *   (up to `maxOutputTokens`, thinking included) is never cut off for being
 *   long. Not retried: a stalled provider retried is a slower one.
 * - `maxAttempts`: provider calls per turn, the first included. Only a
 *   transient failure (rate limited, overloaded, a 5xx, the network, a broken
 *   stream) that has not yet streamed any text is retried.
 * - `retryBackoffMs`: the wait before the second attempt, doubled each time.
 * - `functionTimeoutSeconds`: the Cloud Function's own ceiling, and so the
 *   hard cap on a whole turn. Sized for the longest reply: 16,000 output
 *   tokens streams in a few minutes, well inside it.
 * - `heartbeatIntervalMs`: how often the gateway sends the browser an empty
 *   text chunk while the turn runs (GRV-42). A reply that thinks or writes a
 *   large proposal streams no text for minutes; the heartbeat is how the
 *   browser tells that turn from a connection that died without closing,
 *   which it gives up on after {@link ASSISTANT_CLIENT_SILENCE_MS}.
 */
export interface AssistantCallLimits {
  readonly inactivityTimeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly functionTimeoutSeconds: number;
  /** Defaults to {@link ASSISTANT_HEARTBEAT_INTERVAL_MS}. */
  readonly heartbeatIntervalMs?: number;
}

export const ASSISTANT_HEARTBEAT_INTERVAL_MS = 15_000;

export const ASSISTANT_CALL_LIMITS: AssistantCallLimits = {
  inactivityTimeoutMs: 60_000,
  maxAttempts: 3,
  retryBackoffMs: 1_000,
  functionTimeoutSeconds: 540,
  heartbeatIntervalMs: ASSISTANT_HEARTBEAT_INTERVAL_MS,
};

/**
 * How long the browser waits on a turn that has sent nothing at all, not even
 * a heartbeat, before it reports a `timeout` (GRV-42). Several heartbeats'
 * worth, and past the time a cold start takes to answer, so only a turn whose
 * connection or function has died without closing reaches it.
 */
export const ASSISTANT_CLIENT_SILENCE_MS = 90_000;

/**
 * Limits on what a browser may send in one turn, checked before anything
 * reaches the provider. The history bound below decides what is *resent*;
 * these just refuse a request no client of ours would build.
 */
export const ASSISTANT_REQUEST_LIMITS = {
  /** Messages in one request's conversation, the new one included. */
  maxMessages: 200,
  /** Characters in any one message. */
  maxMessageChars: 8_000,
} as const;

/**
 * Limits on the library a turn may describe and on what a recommendation may
 * name (GRV-23). The library is the published one the app serves: a few
 * hundred sounds today, so the caps refuse a request no client of ours would
 * build rather than trimming a real one.
 *
 * - `maxPacks`, `maxSounds`: packs, and sounds across every pack, in one
 *   request's library.
 * - `maxTags`: tags (genres and characters) on one sound.
 * - `maxDescriptionChars`: a pack's description, which the browser shortens
 *   to this before it sends it.
 * - `maxRecommendedSounds`: sounds one recommendation may suggest.
 * - `maxReasonChars`: the one line on why a recommendation fits.
 */
export const ASSISTANT_LIBRARY_LIMITS = {
  maxPacks: 64,
  maxSounds: 1_000,
  maxTags: 16,
  maxDescriptionChars: 240,
  maxRecommendedSounds: 3,
  maxReasonChars: 200,
} as const;

/**
 * Tokens are estimated, not counted: a count would cost a provider round
 * trip per turn. Three characters per token over-estimates English prose and
 * JSON alike, so the bound errs towards sending less, never more.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3;

/**
 * The most conversation history resent with one turn, in estimated tokens.
 * Well inside the smallest window ({@link SMALLEST_CONTEXT_WINDOW_TOKENS}),
 * because every resent token is paid for again on every turn; the per-turn
 * bound also subtracts the system prompt and project context, so a large
 * selection leaves less room for history rather than overflowing.
 */
export const ASSISTANT_HISTORY_TOKEN_BUDGET = 32_000;

/** Headroom left unused in the window, for the estimate being off. */
export const CONTEXT_WINDOW_MARGIN_TOKENS = 4_000;

/**
 * The assistant's limits (ADR 0006 decisions 4 to 7), all in one place with
 * the transcript retention window, so the gateway, the quota check and the
 * copy that tells a producer the limit can never disagree.
 *
 * - `requestsPerWindow` over `windowMs`: provider calls per account in a
 *   rolling 24 hours. Every provider call counts, retries included, because
 *   the cap tracks spend rather than intent; so the copy says "requests",
 *   never "messages".
 * - `dailySpendCeilingUsd`: the automatic, organisation-wide cut-off, per UTC
 *   day, about eight times the expected cohort load.
 * - `transcriptRetentionDays`: how long Groove keeps a conversation
 *   (ADR 0007 decision 5). Held here for the transcript store (#95) to read.
 */
export const ASSISTANT_LIMITS = {
  requestsPerWindow: 100,
  windowMs: 24 * 60 * 60 * 1000,
  dailySpendCeilingUsd: 25,
  transcriptRetentionDays: 30,
} as const;
