/**
 * The assistant gateway (#69, ADR 0006): one authenticated turn, from the
 * browser's request to a validated, streamed reply.
 *
 * Firebase-free and SDK-free, like `src/access/signInGate.ts`: the Cloud
 * Function (`functions/src/assistantHandler.ts`) supplies the caller, the provider
 * and a logger, and maps the result onto a callable response. Everything that
 * decides anything is here, and is tested here against a scripted provider.
 *
 * A turn:
 *
 * 1. refuses a caller with no account, or a guest (`unauthenticated`);
 * 2. parses the request, whose project context is the ADR 0007 allowlist
 *    (`invalid_request`);
 * 3. stops if the kill switch is off or today's spend ceiling is reached;
 * 4. builds the per-model provider request with a bounded history;
 * 5. reserves one of the account's requests before **every** provider call,
 *    retries included, and adds what each call cost to the day's spend;
 * 6. calls the provider, streaming the reply's text as it arrives, under a
 *    per-attempt inactivity timeout, retrying a transient failure that has
 *    not streamed anything yet, and abandoning the call if the browser goes away;
 * 7. validates the reply and logs one redacted record of how it went: a
 *    reply cut off at `max_tokens` is a `reply_too_long` failure, never a
 *    reply with its proposal or question silently dropped (GRV-42);
 * 8. sends an empty text chunk every few seconds while it runs, so the
 *    browser can tell a long silent turn (thinking, a large proposal) from a
 *    connection that died (GRV-42);
 * 9. keeps the completed turn in the transcript store if, and only if, the
 *    account has said yes (GRV-8, `retention.ts`). Keeping it never fails or
 *    changes the turn: the reply is the same either way.
 *
 * Every turn offers the model the assistant's tool set (GRV-4) and
 * `ask_producer` (GRV-42). A turn that stops for `tool_use` returns its
 * change calls as a proposal stamped with the request's project revision and
 * the tool set's version; the browser validates it against the open project
 * before anything can apply. An `ask_producer` call is not a change: it is
 * validated here and returned as the turn's question, and a malformed one is
 * a malformed reply. A turn that carries the published library is offered
 * `recommend_sounds` as well (GRV-23); its calls come back among the
 * proposal's, and the browser takes them out and checks their IDs against the
 * library it sent.
 */
import { type AssistantAsk, askProducerTool, isAskCall, parseAskCall } from "./ask";
import {
  ASSISTANT_CALL_LIMITS,
  ASSISTANT_HEARTBEAT_INTERVAL_MS,
  ASSISTANT_HISTORY_TOKEN_BUDGET,
  ASSISTANT_LIMITS,
  ASSISTANT_MODEL_ID,
  ASSISTANT_MODELS,
  type AssistantCallLimits,
  type AssistantModelProfile,
  CONTEXT_WINDOW_MARGIN_TOKENS,
  SMALLEST_CONTEXT_WINDOW_TOKENS,
} from "./config";
import type { AssistantGuardStores } from "./guards";
import { type BoundedHistory, boundHistory, estimateTokens } from "./history";
import { ASSISTANT_PROMPT_VERSION, buildSystemBlocks, createIdStem } from "./prompt";
import {
  AssistantGatewayError,
  type AssistantProposal,
  type AssistantStopReason,
  type AssistantStreamChunk,
  type AssistantToolCall,
  type AssistantTurnRequest,
  type AssistantTurnResult,
  assistantTurnRequestSchema,
} from "./protocol";
import { type AssistantProvider, ProviderFailure } from "./provider";
import {
  buildProviderRequest,
  type ProviderMessagesRequest,
  providerTools,
} from "./providerRequest";
import { admitCall, type QuotaLimits, quotaExceededMessage } from "./quota";
import { recommendationTool } from "./recommendation";
import { recordTurn, type TranscriptWrite } from "./retention";
import { costMicroUsd, spendDay, usdToMicro } from "./spend";
import { NO_USAGE, type ProviderUsage, StreamReader } from "./streamEvents";
import { type AssistantTurnLog, toTurnLog } from "./telemetry";
import {
  ASSISTANT_TOOLSET_VERSION,
  assistantTools,
  EXPLAIN_TOOL,
  EXPLAIN_TOOL_NAME,
} from "./tools";
import type { TranscriptStore } from "./transcripts";

/** Who is calling, as the function's auth context reports it. */
export interface AssistantCaller {
  readonly uid: string | null;
  /** `firebase.sign_in_provider` from the ID token, e.g. `google.com`. */
  readonly signInProvider: string | null;
  /**
   * Whether the ID token's address is a team or test account
   * (`isInternalAccount`), so its transcripts are marked internal.
   */
  readonly internalAccount?: boolean;
}

/** The quota and spend figures the gateway enforces. */
export interface AssistantGuardLimits extends QuotaLimits {
  readonly dailySpendCeilingUsd: number;
}

export interface AssistantGatewayDeps {
  readonly provider: AssistantProvider;
  /** The kill switch, the per-account quota and the day's spend. */
  readonly guards: AssistantGuardStores;
  readonly log: (record: AssistantTurnLog) => void;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Waits `ms`, or rejects once `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly model?: AssistantModelProfile;
  /** The stem the turn's new IDs are made from (`prompt.ts`); random by default. */
  readonly idStem?: () => string;
  readonly limits?: AssistantCallLimits;
  readonly guardLimits?: AssistantGuardLimits;
  /**
   * Where a completed turn is kept, if the account allows it (GRV-8).
   * Without one, nothing is kept.
   */
  readonly transcripts?: TranscriptStore;
  /** Hears how keeping each completed turn went: a code, never the content. */
  readonly onTranscript?: (write: TranscriptWrite) => void;
}

export interface AssistantTurnOptions {
  /** Aborts when the browser disconnects. */
  readonly signal: AbortSignal;
  /** Receives the reply's text as it streams. */
  readonly onChunk: (chunk: AssistantStreamChunk) => unknown;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The account's ID as the provider sees it: a SHA-256 of the Firebase uid,
 * which is already pseudonymous, so even that never leaves verbatim.
 */
export async function pseudonymousUserId(uid: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function authenticate(caller: AssistantCaller): string {
  if (!caller.uid) {
    throw new AssistantGatewayError("unauthenticated", "Sign in to use the assistant.");
  }
  if (caller.signInProvider === "anonymous") {
    throw new AssistantGatewayError(
      "unauthenticated",
      "The assistant needs a signed-in account, not a guest session.",
    );
  }
  return caller.uid;
}

function parseRequest(raw: unknown): AssistantTurnRequest {
  const parsed = assistantTurnRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AssistantGatewayError(
      "invalid_request",
      "The assistant request was not valid.",
    );
  }
  return parsed.data;
}

/**
 * The history budget for one turn: the configured ceiling, or what is left of
 * the smallest window once the system prompt, the project context and the
 * reply are accounted for, whichever is less.
 */
export function historyBudgetFor(
  systemTokens: number,
  models: readonly AssistantModelProfile[] = Object.values(ASSISTANT_MODELS),
): number {
  const largestReply = Math.max(...models.map((model) => model.maxOutputTokens));
  const room =
    SMALLEST_CONTEXT_WINDOW_TOKENS -
    largestReply -
    systemTokens -
    CONTEXT_WINDOW_MARGIN_TOKENS;
  return Math.min(ASSISTANT_HISTORY_TOKEN_BUDGET, room);
}

interface PreparedTurn {
  readonly request: ProviderMessagesRequest;
  readonly history: BoundedHistory;
}

async function prepare(
  model: AssistantModelProfile,
  uid: string,
  turn: AssistantTurnRequest,
  idStem: string,
): Promise<PreparedTurn> {
  const system = buildSystemBlocks(turn.context, turn.library, idStem);
  // A turn that carries the library may also recommend from it (GRV-23).
  const tools = [
    ...providerTools([...assistantTools(), EXPLAIN_TOOL, askProducerTool()]),
    ...(turn.library ? [recommendationTool()] : []),
  ];
  // The tool definitions take room in the window just as the prompt does.
  const systemTokens =
    system.reduce((sum, block) => sum + estimateTokens(block.text), 0) +
    estimateTokens(JSON.stringify(tools));
  const history = boundHistory(turn.messages, historyBudgetFor(systemTokens));
  if (history.messages.length === 0) {
    throw new AssistantGatewayError(
      "invalid_request",
      "The selection and message are too large for the assistant to read at once.",
    );
  }
  const request = buildProviderRequest(model, {
    system,
    messages: history.messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
    tools,
    pseudonymousUserId: await pseudonymousUserId(uid),
  });
  return { request, history };
}

/** The outcome of one provider call. */
type AttemptOutcome =
  | {
      kind: "completed";
      text: string;
      stopReason: AssistantStopReason;
      toolCalls: AssistantToolCall[];
    }
  | { kind: "failed"; failure: ProviderFailure; streamedText: boolean }
  | { kind: "timed_out" }
  | { kind: "cancelled" };

interface Attempt {
  readonly outcome: AttemptOutcome;
  /** The provider's own token counts, as logged. */
  readonly usage: ProviderUsage;
  /** What the call is charged against the spend ceiling (`StreamReader.billableUsage`). */
  readonly billedUsage: ProviderUsage;
}

/**
 * One provider call under an inactivity timeout and the browser's
 * cancellation. The timer restarts on every event the provider sends, so only
 * a call that goes quiet times out, however long its reply. Each `next()`
 * races the abort, so a provider that ignores its signal still cannot hold
 * the turn past the timeout.
 */
async function attemptCall(
  deps: AssistantGatewayDeps,
  request: ProviderMessagesRequest,
  options: AssistantTurnOptions,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const onCancel = () => controller.abort();
  options.signal.addEventListener("abort", onCancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  restartTimer();
  const aborted = new Promise<"aborted">((resolve) => {
    if (controller.signal.aborted) resolve("aborted");
    controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  const reader = new StreamReader();
  let iterator: AsyncIterator<unknown> | undefined;
  const stopped = (): AttemptOutcome =>
    timedOut ? { kind: "timed_out" } : { kind: "cancelled" };
  const ended = (outcome: AttemptOutcome): Attempt => ({
    outcome,
    usage: reader.usage,
    billedUsage: reader.billableUsage,
  });
  try {
    if (options.signal.aborted)
      return { outcome: { kind: "cancelled" }, usage: NO_USAGE, billedUsage: NO_USAGE };
    iterator = deps.provider.stream(request, controller.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === "aborted") return ended(stopped());
      if (next.done) break;
      restartTimer();
      const text = reader.accept(next.value);
      if (text) await options.onChunk({ type: "text", text });
    }
    if (controller.signal.aborted) return ended(stopped());
    const result = reader.result();
    return ended({ kind: "completed", ...result });
  } catch (error) {
    if (controller.signal.aborted) return ended(stopped());
    const failure =
      error instanceof ProviderFailure ? error : new ProviderFailure("malformed");
    return ended({ kind: "failed", failure, streamedText: reader.hasText });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onCancel);
    if (controller.signal.aborted) void iterator?.return?.()?.catch(() => {});
  }
}

function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function errorForFailure(failure: ProviderFailure): AssistantGatewayError {
  switch (failure.kind) {
    case "rejected":
      return new AssistantGatewayError(
        "provider_error",
        "The assistant could not take that request.",
      );
    case "unsupported_stop":
      return new AssistantGatewayError(
        "provider_error",
        "The assistant stopped before it finished its reply. Try asking another way.",
      );
    case "malformed":
      return new AssistantGatewayError(
        "malformed_response",
        "The assistant's reply came back garbled. Try again.",
      );
    default:
      return new AssistantGatewayError(
        "provider_unavailable",
        "The assistant is busy right now. Try again in a moment.",
      );
  }
}

const DISABLED_MESSAGE =
  "The assistant is switched off for now. Everything else in Groove works as usual.";
const CEILING_MESSAGE =
  "The assistant has paused for the rest of the day. Everything else in Groove works as usual.";

/**
 * Stops the turn if the day's spend has reached the ceiling.
 *
 * Not transactional: it reads the total, and the call's cost is added only
 * once the call ends, so turns running at the same moment can each pass the
 * check and together go a little over the ceiling, by at most one call each.
 * Acceptable for the alpha cohort's handful of concurrent turns; the ceiling
 * is a cut-off, not a billing guarantee.
 */
async function checkSpend(
  guards: AssistantGuardStores,
  now: number,
  limits: AssistantGuardLimits,
): Promise<void> {
  const spent = await guards.spentMicroUsd(spendDay(now));
  if (spent >= usdToMicro(limits.dailySpendCeilingUsd)) {
    throw new AssistantGatewayError("spend_ceiling_reached", CEILING_MESSAGE);
  }
}

/** Takes one of the account's requests, or stops the turn naming when one frees up. */
async function reserveCall(
  guards: AssistantGuardStores,
  uid: string,
  now: number,
  limits: AssistantGuardLimits,
): Promise<number> {
  const decision = await guards.reserveCall(uid, (record) =>
    admitCall(record, now, limits),
  );
  if (!decision.allowed) {
    throw new AssistantGatewayError(
      "quota_exceeded",
      quotaExceededMessage(decision.resetsAt, limits.requestsPerWindow),
      decision.resetsAt,
    );
  }
  return decision.remaining;
}

/**
 * The turn's change calls as a proposal, or null when it made none. An
 * explanation on its own changes nothing, so it is not a proposal either.
 */
function proposalOf(
  turn: AssistantTurnRequest,
  allCalls: readonly AssistantToolCall[],
): AssistantProposal | null {
  const calls = allCalls.filter((call) => !isAskCall(call));
  if (calls.every((call) => call.name === EXPLAIN_TOOL_NAME)) return null;
  return {
    baseRevision: turn.projectRevision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    calls,
  };
}

/**
 * Keeps a completed turn in the transcript store, when there is one and the
 * request named its session. `recordTurn` reads the account's preference in
 * the same transaction as the write and never throws, so this cannot fail or
 * alter the turn.
 */
async function keepTranscript(
  deps: AssistantGatewayDeps,
  uid: string,
  caller: AssistantCaller,
  turn: AssistantTurnRequest,
  receivedAt: number,
  reply: {
    text: string;
    stopReason: AssistantStopReason;
    proposal: AssistantProposal | null;
    model: string;
  },
): Promise<void> {
  if (!deps.transcripts || !turn.session) return;
  const write = await recordTurn(deps.transcripts, {
    uid,
    session: turn.session,
    internalAccount: caller.internalAccount ?? false,
    projectRevision: turn.projectRevision,
    userMessage: turn.messages[turn.messages.length - 1]?.text ?? "",
    reply: reply.text,
    stopReason: reply.stopReason,
    proposal: reply.proposal,
    model: reply.model,
    promptVersion: ASSISTANT_PROMPT_VERSION,
    receivedAt,
  });
  deps.onTranscript?.(write);
}

const TOO_LONG_MESSAGE =
  "The assistant's reply ran out of room before it finished. Try asking for a smaller change.";

/**
 * Sends `onChunk` an empty text chunk every `intervalMs` until the returned
 * stop is called. A heartbeat that cannot be sent is ignored: the turn's own
 * chunks report a dead connection.
 */
function startHeartbeat(
  onChunk: AssistantTurnOptions["onChunk"],
  intervalMs: number,
): () => void {
  const beat = () => {
    try {
      void Promise.resolve(onChunk({ type: "text", text: "" })).catch(() => {});
    } catch {
      // As above: a heartbeat never fails the turn.
    }
  };
  const timer = setInterval(beat, intervalMs);
  return () => clearInterval(timer);
}

/**
 * The turn's question, or null when it asks none. The first `ask_producer`
 * call is the question; the tool asks one at a time, so any later one is
 * dropped. One that does not parse makes the reply malformed.
 */
function askOf(calls: readonly AssistantToolCall[]): AssistantAsk | null {
  const call = calls.find(isAskCall);
  if (!call) return null;
  const ask = parseAskCall(call);
  if (!ask) {
    throw new AssistantGatewayError(
      "malformed_response",
      "The assistant's question came back garbled. Try again.",
    );
  }
  return ask;
}

/**
 * Runs one assistant turn. Resolves with the validated reply, or rejects with
 * an {@link AssistantGatewayError}; either way it logs exactly one
 * {@link AssistantTurnLog}.
 */
export async function runAssistantTurn(
  deps: AssistantGatewayDeps,
  caller: AssistantCaller,
  rawRequest: unknown,
  options: AssistantTurnOptions,
): Promise<AssistantTurnResult> {
  const model = deps.model ?? ASSISTANT_MODELS[ASSISTANT_MODEL_ID];
  const limits = deps.limits ?? ASSISTANT_CALL_LIMITS;
  const sleep = deps.sleep ?? defaultSleep;
  const guardLimits = deps.guardLimits ?? ASSISTANT_LIMITS;
  const startedAt = deps.now();
  const failures: { kind: ProviderFailure["kind"]; status: number | null }[] = [];
  let attempts = 0;
  let usage = NO_USAGE;
  let history: BoundedHistory = { messages: [], dropped: 0 };

  const finish = (
    outcome: AssistantTurnLog["outcome"],
    stopReason: AssistantStopReason | null,
  ) =>
    deps.log(
      toTurnLog({
        outcome,
        model: model.id,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        failures,
        attempts,
        stopReason,
        durationMs: deps.now() - startedAt,
        usage,
        historySent: history.messages.length,
        historyDropped: history.dropped,
      }),
    );

  const stopHeartbeat = startHeartbeat(
    options.onChunk,
    limits.heartbeatIntervalMs ?? ASSISTANT_HEARTBEAT_INTERVAL_MS,
  );
  try {
    const uid = authenticate(caller);
    const turn = parseRequest(rawRequest);
    if (!(await deps.guards.isEnabled())) {
      throw new AssistantGatewayError("assistant_disabled", DISABLED_MESSAGE);
    }
    const prepared = await prepare(model, uid, turn, (deps.idStem ?? createIdStem)());
    history = prepared.history;

    while (true) {
      // A browser already gone costs the account nothing.
      if (options.signal.aborted) {
        throw new AssistantGatewayError(
          "cancelled",
          "The assistant request was cancelled.",
        );
      }
      await checkSpend(deps.guards, deps.now(), guardLimits);
      const requestsRemaining = await reserveCall(
        deps.guards,
        uid,
        deps.now(),
        guardLimits,
      );
      attempts += 1;
      const attempt = await attemptCall(
        deps,
        prepared.request,
        options,
        limits.inactivityTimeoutMs,
      );
      usage = addUsage(usage, attempt.usage);
      const cost = costMicroUsd(model, attempt.billedUsage);
      if (cost > 0) await deps.guards.addSpend(spendDay(deps.now()), cost);
      const { outcome } = attempt;
      if (outcome.kind === "completed") {
        // Cut off before it finished: whatever it was proposing or asking is
        // gone (`StreamReader.result`), and its text may stop mid-sentence.
        // Said as a failure, not passed off as a reply that did nothing.
        if (outcome.stopReason === "max_tokens") {
          throw new AssistantGatewayError("reply_too_long", TOO_LONG_MESSAGE);
        }
        const ask = askOf(outcome.toolCalls);
        finish("completed", outcome.stopReason);
        const proposal = proposalOf(turn, outcome.toolCalls);
        await keepTranscript(deps, uid, caller, turn, startedAt, {
          text: outcome.text,
          stopReason: outcome.stopReason,
          proposal,
          model: model.id,
        });
        return {
          text: outcome.text,
          stopReason: outcome.stopReason,
          proposal,
          ask,
          model: model.id,
          promptVersion: ASSISTANT_PROMPT_VERSION,
          requestsRemaining,
        };
      }
      if (outcome.kind === "cancelled") {
        throw new AssistantGatewayError(
          "cancelled",
          "The assistant request was cancelled.",
        );
      }
      if (outcome.kind === "timed_out") {
        throw new AssistantGatewayError(
          "timeout",
          "The assistant took too long to answer. Try again.",
        );
      }
      failures.push({ kind: outcome.failure.kind, status: outcome.failure.status });
      const retry =
        outcome.failure.transient &&
        !outcome.streamedText &&
        attempts < limits.maxAttempts;
      if (!retry) throw errorForFailure(outcome.failure);
      try {
        await sleep(limits.retryBackoffMs * 2 ** (attempts - 1), options.signal);
      } catch {
        throw new AssistantGatewayError(
          "cancelled",
          "The assistant request was cancelled.",
        );
      }
    }
  } catch (error) {
    if (error instanceof AssistantGatewayError) {
      finish(error.code, null);
      throw error;
    }
    // Not a known failure (a store that could not be reached, a bug): logged
    // as such, and left for the function to report as an internal error.
    finish("internal_error", null);
    throw error;
  } finally {
    stopHeartbeat();
  }
}
