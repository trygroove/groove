/**
 * When an eval run or an experiment must stop starting turns, because every
 * later one would be refused the same way and spend the run on nothing:
 *
 * - the provider rejected the API key (HTTP 401/403) before any turn replied;
 * - the provider said the account is out of credit (a 400 it tells apart);
 * - the provider refused {@link REFUSAL_STREAK} turns in a row with a client
 *   error and nothing replied between them. This one does not depend on the
 *   provider's wording: an exhausted balance, a spend limit reached in the
 *   Anthropic Console or a request every call gets wrong all look like this,
 *   and the API's message is never kept to tell them apart (`provider.ts`).
 *   Without it, GRV-143's run posted "no win" from 90 of 114 errored control
 *   turns, and GRV-147's ran 798 turns that all came back 400.
 *
 * Both `runEvals` (`run.ts`) and an experiment's phases (`experimentRun.ts`)
 * feed it every finished turn; the reason it returns is what the report and
 * the card say.
 */
import type { EvalTurn, EvalTurnError } from "./run";

/** How many refused turns in a row, with no reply between them, stop a run. */
export const REFUSAL_STREAK = 10;

export const AUTH_ABORT_REASON =
  "The provider rejected the API key (HTTP 401/403), so no further turns were run.";

export const CREDIT_ABORT_REASON =
  "The account ran out of API credit (HTTP 400, credit balance too low), so no further turns were run. Top it up and rerun the cases that errored.";

/** The reason a refusal streak stops a run, naming the status it saw. */
export function refusalAbortReason(status: number): string {
  return `The provider refused ${REFUSAL_STREAK} turns in a row (HTTP ${status}) with no reply between them, so no further turns were run. Every call is being refused: most likely the account is out of API credit or has reached its spend limit in the Anthropic Console. Fix that, then rerun.`;
}

export function isAuthError(error: EvalTurnError | null | undefined): boolean {
  return error?.providerStatus === 401 || error?.providerStatus === 403;
}

/**
 * A turn the provider refused outright: a 4xx it will answer the same way
 * next time. A rate limit (429) or a timeout (408) passes, so is not one.
 */
export function isRefusal(error: EvalTurnError | null | undefined): boolean {
  const status = error?.providerStatus;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/** Watches finished turns, in the order they finish, for a reason to stop. */
export class RunGuard {
  #replied = false;
  #streak = 0;
  #reason: string | null = null;

  /** Why the run must stop, or null while it may go on. The first reason sticks. */
  get reason(): string | null {
    return this.#reason;
  }

  /** One finished turn. Returns {@link reason}. */
  observe(turn: Pick<EvalTurn, "error" | "turnError">): string | null {
    if (!turn.error) {
      this.#replied = true;
      this.#streak = 0;
      return this.#reason;
    }
    const error = turn.turnError ?? null;
    if (!this.#replied && isAuthError(error)) this.#reason ??= AUTH_ABORT_REASON;
    // Credit can run out mid-run: every later turn would be refused too.
    if (error?.outOfCredit) this.#reason ??= CREDIT_ABORT_REASON;
    if (error && isRefusal(error)) {
      this.#streak += 1;
      if (this.#streak >= REFUSAL_STREAK) {
        this.#reason ??= refusalAbortReason(error.providerStatus as number);
      }
    } else {
      // A timeout or an overload says nothing about the account.
      this.#streak = 0;
    }
    return this.#reason;
  }
}
