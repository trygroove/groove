/**
 * The provider boundary (ADR 0006 decision 1).
 *
 * The gateway talks to a model through this interface and nothing else. The
 * production implementation (`functions/src/anthropicProvider.ts`) is the
 * only code that holds the API key or an SDK object; tests script one
 * ({@link "../testing/scriptedAssistantProvider"}). Neither ever reaches the
 * browser or project state.
 *
 * A provider yields the stream's **raw wire events** (the Messages API's
 * server-sent events, parsed from JSON). Interpreting and validating them is
 * the gateway's job (`streamEvents.ts`), so a scripted provider exercises the
 * same validation a real one does, malformed events included.
 */
import type { ProviderMessagesRequest } from "./providerRequest";

export interface AssistantProvider {
  /**
   * Starts one provider call. Aborting `signal` abandons it: the iterable
   * stops, early, without throwing.
   */
  stream(request: ProviderMessagesRequest, signal: AbortSignal): AsyncIterable<unknown>;
}

/**
 * How a provider call failed, as the gateway needs to know it.
 *
 * - `rate_limited` (429), `overloaded` (529), `server_error` (5xx) and
 *   `network`: transient, retried while nothing has streamed.
 * - `malformed`: the stream was not the Messages API's (bad JSON, a known
 *   event of the wrong shape, events out of order). Retried the same way.
 * - `rejected`: the provider refused the request itself (a 4xx other than
 *   429), including a bad or missing API key. Never retried.
 * - `unsupported_stop`: a well-formed stream that ended for a reason a
 *   turn never has (`pause_turn`, a reason newer than this code). `tool_use`
 *   is not one: it ends a turn that proposes changes (GRV-4). Asking again asks the same model the same thing, so it is
 *   never retried and never spends another call's quota.
 */
export type ProviderFailureKind =
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "network"
  | "malformed"
  | "rejected"
  | "unsupported_stop";

const TRANSIENT: ReadonlySet<ProviderFailureKind> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "network",
  "malformed",
]);

/**
 * The provider's own reason for refusing a call: the `type` and `message` of
 * the API's error body, already scrubbed. Only the evals' provider keeps one
 * (`evals/providerReason.ts`); production never does.
 */
export interface ProviderRejection {
  readonly type: string;
  readonly message: string;
}

/**
 * A failed provider call. Carries the HTTP status where there was one, and
 * deliberately not the provider's message, which can quote the request. The
 * evals alone attach a scrubbed {@link ProviderRejection}, so a refused run
 * says why.
 */
export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | null;
  /**
   * The account has no API credit left: every call will be refused the same
   * way until it is topped up. A `rejected` 400, told apart by the provider's
   * message, which is never kept. The evals stop on it (`evals/run.ts`).
   */
  readonly outOfCredit: boolean;
  /** Why the provider refused, where the evals kept it; otherwise `null`. */
  readonly reason: ProviderRejection | null;

  constructor(
    kind: ProviderFailureKind,
    status: number | null = null,
    options: {
      readonly outOfCredit?: boolean;
      readonly reason?: ProviderRejection | null;
    } = {},
  ) {
    super(`provider call failed: ${kind}${status === null ? "" : ` (${status})`}`);
    this.name = "ProviderFailure";
    this.kind = kind;
    this.status = status;
    this.outOfCredit = options.outOfCredit ?? false;
    this.reason = options.reason ?? null;
  }

  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }
}

/** The failure kind for an HTTP status the provider answered with. */
export function failureKindForStatus(status: number): ProviderFailureKind {
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server_error";
  return "rejected";
}
