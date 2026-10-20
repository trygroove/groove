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
 *    retries included, and adds what each call cost to the day's spend (an
 *    internal or admin account skips the ceiling and the quota, GRV-112);
 * 6. calls the provider, streaming the reply's text as it arrives, under a
 *    per-attempt inactivity timeout, retrying a transient failure that has
 *    not streamed anything yet, and abandoning the call if the browser goes away;
 * 7. validates the reply and logs one redacted record of how it went: a
 *    reply cut off at `max_tokens` is a `reply_too_long` failure, never a
 *    reply with its proposal or question silently dropped (GRV-42);
 * 8. sends an empty text chunk every few seconds while it runs, so the
 *    browser can tell a long silent turn (thinking, a large proposal) from a
 *    connection that died (GRV-42);
 * 9. keeps the completed turn in the transcript store unless the account
 *    has said no (GRV-8, GRV-97, `retention.ts`). Keeping it never fails or
 *    changes the turn: the reply is the same either way;
 * 10. hands one `$ai_generation` event per provider call to the trace sink,
 *    completed or failed, when the browser said product analytics is allowed
 *    (GRV-126, `traces.ts`), with the request and reply in it only for an
 *    account whose conversations are kept. Tracing never fails or changes
 *    the turn either.
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
 * library it sent. One aimed at a track or pad that neither the project nor
 * the turn's earlier calls have is refused back to the model (GRV-129,
 * `steps.ts`). A turn whose gateway can search YouTube is offered
 * `recommend_video` too (GRV-16, ADR 0009): its calls are taken out of the
 * proposal, searched for here, and returned as the turn's `videos`, with
 * every search that finds nothing YouTube vouches for dropped.
 *
 * Each change call the turn accepts, in call order, is also streamed to the
 * browser as a proposal part the moment the step that made it is answered
 * (GRV-144), so the card fills in part by part while the turn goes on. A
 * refused call is never streamed. The completed turn still returns the
 * whole proposal.
 *
 * Under the `toolBundles` tactic at `bundled` (GRV-143), a turn is offered
 * one fixed bundle of the command tools instead of all of them, picked by a
 * pure rule over the request (`toolBundleRule.ts`). A bundle short of every
 * tool carries `need_more_tools`: a step that calls it runs again, the same
 * messages with every tool. A call to a tool the bundle did not offer is
 * taken as any call is, and every later step offers every tool. The turn log
 * names the bundle and any fallback.
 */
import { type AssistantAsk, askProducerTool, isAskCall, parseAskCall } from "./ask";
import { contextClips } from "./clipReuse";
import {
  createNoteExpander,
  expandAskPreviews,
  type StepStringOptions,
} from "./compactNotes";
import {
  ASSISTANT_CALL_LIMITS,
  ASSISTANT_HEARTBEAT_INTERVAL_MS,
  ASSISTANT_HISTORY_TOKEN_BUDGET,
  ASSISTANT_LIMITS,
  ASSISTANT_MAX_STEPS,
  ASSISTANT_MODEL_ID,
  ASSISTANT_MODELS,
  type AssistantCallLimits,
  type AssistantModelProfile,
  CONTEXT_WINDOW_MARGIN_TOKENS,
  SMALLEST_CONTEXT_WINDOW_TOKENS,
} from "./config";
import type { AssistantGuardStores } from "./guards";
import { type BoundedHistory, boundHistory, estimateTokens } from "./history";
import { rememberTool } from "./memory";
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
  continuesTurn,
  type ProviderAssistantBlock,
  type ProviderMessagesRequest,
  type ProviderTool,
  providerTools,
} from "./providerRequest";
import { admitCall, type QuotaLimits, quotaExceededMessage } from "./quota";
import { recommendationTool } from "./recommendation";
import { contextTargets, withCreatedTargets } from "./recommendationTargets";
import { recordTurn, type TranscriptWrite } from "./retention";
import { costMicroUsd, spendDay, usdToMicro } from "./spend";
import {
  answerStep,
  CHANGE_STEPS_SPENT,
  continuesAfter,
  expandCalls,
  goesOnToRefuse,
  isChangeCall,
  isProposalPart,
  MAX_CHANGE_STEPS,
  misaimedIn,
  refusedIn,
} from "./steps";
import { NO_USAGE, type ProviderUsage, StreamReader } from "./streamEvents";
import { resolveTactics, type TacticOverrides, type TacticValues } from "./tactics";
import { type AssistantTurnLog, type ToolBundleFallback, toTurnLog } from "./telemetry";
import { toolBundleFor } from "./toolBundleRule";
import {
  ASSISTANT_TOOLSET_VERSION,
  bundleTools,
  EVERYTHING_BUNDLE,
  EXPLAIN_TOOL,
  isNeedMoreToolsCall,
  makesChanges,
  NEED_MORE_TOOLS_TOOL,
  type ToolBundleId,
  withProviderToolText,
  withToolText,
} from "./tools";
import {
  type AssistantTraceSink,
  aiSessionIdFor,
  type GenerationCall,
  type GenerationResult,
  generationEvents,
  traceConsent,
} from "./traces";
import { permitsRetention, type TranscriptStore } from "./transcripts";
import {
  type CheckedVideos,
  checkVideoCalls,
  droppedVideoNote,
  isVideoCall,
  NO_VIDEOS,
  type VideoFinder,
  videoRecommendationTool,
} from "./video";

/** Who is calling, as the function's auth context reports it. */
export interface AssistantCaller {
  readonly uid: string | null;
  /** `firebase.sign_in_provider` from the ID token, e.g. `google.com`. */
  readonly signInProvider: string | null;
  /**
   * Whether the ID token carries the `internal` claim (`hasInternalClaim`,
   * `src/access/claims.ts`), so its transcripts are marked internal.
   */
  readonly internalAccount?: boolean;
  /**
   * Whether the ID token carries the `internal` or `admin` claim
   * (`hasUnlimitedClaim`, GRV-112), so the account is held to neither its
   * request quota nor the day's spend ceiling. Its calls still add to the
   * day's spend, and the kill switch still stops it.
   */
  readonly unlimited?: boolean;
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
  /**
   * The tactics the turn runs with (`tactics.ts`, GRV-110), any left out at
   * production's default. Production passes none; the evals and experiments
   * pass the values they are measuring.
   */
  readonly tactics?: TacticOverrides;
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
  /**
   * Searches YouTube for a video the model recommends and checks it is real
   * and embeddable (GRV-16, ADR 0009 decision 5), from the server. Without
   * one the model is not offered `recommend_video`, and any call it makes
   * anyway is dropped.
   */
  readonly findVideo?: VideoFinder;
  /**
   * Where the turn's `$ai_generation` events go (GRV-126): PostHog's AI
   * Observability, from the Cloud Function. Without one, nothing is traced.
   */
  readonly traces?: AssistantTraceSink;
  /** A fresh trace ID for a turn whose request names no session; random by default. */
  readonly traceId?: () => string;
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
  /**
   * The bundle the turn opens with under `toolBundles=bundled` (GRV-143), or
   * null under `all`, which offers every tool as it always has.
   */
  readonly bundle: ToolBundleId | null;
  /** Every tool, for a step re-run after `need_more_tools`. */
  readonly everything: ProviderTool[];
}

/**
 * The tools a turn offers with `bundle`'s command tools: those, then
 * `explain_change` and `ask_producer`, then `need_more_tools` in a bundle that
 * is not every tool (GRV-143), then the conditional tools. The command tools
 * and the two after them come first and never vary with the request, so the
 * prompt cache keeps one prefix per bundle.
 */
function offeredTools(
  bundle: ToolBundleId,
  tactics: TacticValues,
  turn: AssistantTurnRequest,
  videos: boolean,
): ProviderTool[] {
  // A turn that carries the library may also recommend from it (GRV-23), one
  // that can search YouTube may recommend a tutorial (GRV-16), and one that
  // carries the producer's memory may propose adding to it (GRV-25).
  return [
    ...providerTools([
      ...bundleTools(
        bundle,
        tactics.toolText,
        tactics.drumStepStrings,
        tactics.patternGenerators,
        tactics.clipReuse,
      ),
      withToolText(EXPLAIN_TOOL, tactics.toolText),
      withToolText(askProducerTool(), tactics.toolText),
      ...(bundle === EVERYTHING_BUNDLE ? [] : [NEED_MORE_TOOLS_TOOL]),
    ]),
    ...(turn.library
      ? [withProviderToolText(recommendationTool(), tactics.toolText)]
      : []),
    ...(videos
      ? [withProviderToolText(videoRecommendationTool(), tactics.toolText)]
      : []),
    ...(turn.memory
      ? providerTools([withToolText(rememberTool(), tactics.toolText)])
      : []),
  ];
}

async function prepare(
  model: AssistantModelProfile,
  tactics: TacticValues,
  uid: string,
  turn: AssistantTurnRequest,
  idStem: string,
  videos: boolean,
): Promise<PreparedTurn> {
  const system = buildSystemBlocks(
    turn.context,
    turn.library,
    idStem,
    turn.memory,
    tactics,
  );
  const everything = offeredTools(EVERYTHING_BUNDLE, tactics, turn, videos);
  const bundle = tactics.toolBundles === "bundled" ? toolBundleFor(turn) : null;
  const tools =
    bundle === null || bundle === EVERYTHING_BUNDLE
      ? everything
      : offeredTools(bundle, tactics, turn, videos);
  // The tool definitions take room in the window just as the prompt does.
  // Every tool's, whatever the bundle, so a step re-run with them all fits.
  const systemTokens =
    system.reduce((sum, block) => sum + estimateTokens(block.text), 0) +
    estimateTokens(JSON.stringify(everything));
  const history = boundHistory(turn.messages, historyBudgetFor(systemTokens));
  if (history.messages.length === 0) {
    throw new AssistantGatewayError(
      "invalid_request",
      "The selection and message are too large for the assistant to read at once.",
    );
  }
  const request = buildProviderRequest(
    model,
    {
      system,
      messages: history.messages.map((message) => ({
        role: message.role,
        content: message.text,
      })),
      tools,
      pseudonymousUserId: await pseudonymousUserId(uid),
    },
    tactics,
  );
  return { request, history, bundle, everything };
}

/** The outcome of one provider call. */
type AttemptOutcome =
  | {
      kind: "completed";
      text: string;
      stopReason: AssistantStopReason;
      toolCalls: AssistantToolCall[];
      /** The reply's blocks, to send back if the turn continues. */
      content: ProviderAssistantBlock[];
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

  const reader = new StreamReader(continuesTurn(request));
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
  const calls = allCalls.filter((call) => !isAskCall(call) && !isVideoCall(call));
  if (!makesChanges(calls)) return null;
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

/** How one call ended, as its trace tells it. */
function generationResult(outcome: AttemptOutcome): GenerationResult {
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "completed",
        text: outcome.text,
        stopReason: outcome.stopReason,
        toolCalls: outcome.toolCalls,
      };
    case "failed":
      return {
        kind: "failed",
        failure: outcome.failure.kind,
        status: outcome.failure.status,
      };
    default:
      return outcome;
  }
}

/**
 * Whether the account lets Groove keep its conversations, read from the
 * transcript store for this turn (`permitsRetention`). No store, or one that
 * cannot be read, is a no: the trace then carries no content.
 */
async function retentionPermitted(
  store: TranscriptStore | undefined,
  uid: string,
): Promise<boolean> {
  if (!store) return false;
  try {
    return permitsRetention(await store.preference(uid));
  } catch {
    return false;
  }
}

/** What a traced turn knows once its request has parsed. */
interface Tracing {
  readonly sink: AssistantTraceSink;
  readonly uid: string;
  readonly turn: AssistantTurnRequest;
  readonly turnKey: string;
  /** Read as the turn starts, so it is ready by the time the turn ends. */
  readonly retention: Promise<boolean>;
}

/** What separates one step's text from the next in the reply. */
const PARAGRAPH = "\n\n";

/**
 * `options` for a step after one that said something: its first text starts
 * a new paragraph, so each step's sentence reads as its own update.
 */
function paragraphAfter(options: AssistantTurnOptions): AssistantTurnOptions {
  let first = true;
  return {
    ...options,
    onChunk(chunk) {
      if (!first || chunk.type !== "text" || chunk.text.length === 0) {
        return options.onChunk(chunk);
      }
      first = false;
      return options.onChunk({ ...chunk, text: PARAGRAPH + chunk.text });
    },
  };
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

function offers(tools: readonly ProviderTool[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

/**
 * What the note expander needs to write out drum step strings (GRV-140),
 * pattern generator calls (GRV-141) and clip reuse's short placements,
 * copies and duplicates (GRV-131), or undefined when the `drumStepStrings`,
 * `patternGenerators` and `clipReuse` tactics are all off and none is
 * offered: a string's or a generator's pads are checked against the
 * project's tracks and those the turn's accepted calls make, and a reused
 * clip is one the context or an accepted call tells of.
 */
function stepStringOptions(
  tactics: TacticValues,
  context: AssistantTurnRequest["context"],
): StepStringOptions | undefined {
  const stepStrings = tactics.drumStepStrings === "on";
  const generators = tactics.patternGenerators === "on";
  const reuse = tactics.clipReuse === "on";
  if (!stepStrings && !generators && !reuse) return undefined;
  return {
    targets: contextTargets(context),
    track: withCreatedTargets,
    stepStrings,
    generators,
    ...(reuse ? { clipReuse: contextClips(context) } : {}),
  };
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
  // Every tactic value the turn reads comes from here (GRV-110).
  const tactics = resolveTactics(deps.tactics);
  const limits = deps.limits ?? ASSISTANT_CALL_LIMITS;
  const sleep = deps.sleep ?? defaultSleep;
  const guardLimits = deps.guardLimits ?? ASSISTANT_LIMITS;
  const startedAt = deps.now();
  const failures: { kind: ProviderFailure["kind"]; status: number | null }[] = [];
  let attempts = 0;
  let usage = NO_USAGE;
  let history: BoundedHistory = { messages: [], dropped: 0 };
  let checked: CheckedVideos = NO_VIDEOS;
  const generations: GenerationCall[] = [];
  let tracing: Tracing | null = null;
  // The bundle the turn opened with, and why it went on with every tool, if
  // it did (GRV-143).
  let toolBundle: ToolBundleId | null = null;
  let bundleFallback: ToolBundleFallback | null = null;

  /**
   * Hands the turn's events to the sink, once it has ended. Never throws, and
   * waits for nothing but the retention read begun at the start of the turn.
   */
  const trace = async (outcome: AssistantTurnLog["outcome"]) => {
    if (!tracing || generations.length === 0) return;
    try {
      const { sink, uid, turn, turnKey } = tracing;
      const includeContent = await tracing.retention;
      const events = generationEvents(
        {
          uid,
          traceId: turnKey,
          aiSessionId: aiSessionIdFor(turn),
          sessionId: turn.analytics?.sessionId ?? null,
          model: model.id,
          promptVersion: ASSISTANT_PROMPT_VERSION,
          outcome,
          internal:
            (caller.internalAccount ?? false) || (turn.session?.internal ?? false),
          includeContent,
        },
        generations,
      );
      for (const event of events) sink.capture(event);
    } catch {
      // A trace never fails or changes the turn.
    }
  };

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
        videosShown: checked.videos.length,
        videosDropped: checked.dropped,
        videosUnchecked: checked.unchecked,
        toolBundle,
        toolBundleFallback: bundleFallback,
      }),
    );

  const stopHeartbeat = startHeartbeat(
    options.onChunk,
    limits.heartbeatIntervalMs ?? ASSISTANT_HEARTBEAT_INTERVAL_MS,
  );
  try {
    const uid = authenticate(caller);
    const turn = parseRequest(rawRequest);
    if (deps.traces && traceConsent(turn)) {
      tracing = {
        sink: deps.traces,
        uid,
        turn,
        turnKey: turn.session?.turnId ?? (deps.traceId ?? (() => crypto.randomUUID()))(),
        retention: retentionPermitted(deps.transcripts, uid),
      };
    }
    if (!(await deps.guards.isEnabled())) {
      throw new AssistantGatewayError("assistant_disabled", DISABLED_MESSAGE);
    }
    const idStem = (deps.idStem ?? createIdStem)();
    const prepared = await prepare(
      model,
      tactics,
      uid,
      turn,
      idStem,
      deps.findVideo !== undefined,
    );
    // Notes come as short arrays and join the proposal as note events, their
    // IDs from the turn's stem (`compactNotes.ts`, GRV-131).
    // With the drumStepStrings tactic on, a drum pad's step string is written
    // out the same way (`drumSteps.ts`, GRV-140), and with patternGenerators
    // on, a generator call (`generators/`, GRV-141). With clipReuse on, a
    // short placement, a copied clip and a notes_duplicate with no newIds are
    // written out too (`clipReuse.ts`, GRV-131).
    const stepStrings = stepStringOptions(tactics, turn.context);
    const notes = createNoteExpander(idStem, undefined, stepStrings);
    history = prepared.history;
    toolBundle = prepared.bundle;
    // The tools each step offers: the turn's bundle until the model asks for
    // more or reaches past it, every tool from then on (GRV-143).
    let tools = prepared.request.tools;
    let narrowed = toolBundle !== null && toolBundle !== EVERYTHING_BUNDLE;

    const cancelled = () =>
      new AssistantGatewayError("cancelled", "The assistant request was cancelled.");

    /**
     * One step's provider call, retried on a transient failure that has not
     * streamed anything yet. Every attempt is one of the account's requests.
     */
    const callProvider = async (
      request: ProviderMessagesRequest,
      stepOptions: AssistantTurnOptions,
    ) => {
      while (true) {
        // A browser already gone costs the account nothing.
        if (options.signal.aborted) throw cancelled();
        // An unlimited account takes no request from a window and is not
        // stopped by the ceiling; it always has a full window left.
        let remaining = guardLimits.requestsPerWindow;
        if (!caller.unlimited) {
          await checkSpend(deps.guards, deps.now(), guardLimits);
          remaining = await reserveCall(deps.guards, uid, deps.now(), guardLimits);
        }
        attempts += 1;
        const callStartedAt = tracing ? deps.now() : 0;
        const attempt = await attemptCall(
          deps,
          request,
          stepOptions,
          limits.inactivityTimeoutMs,
        );
        if (tracing) {
          generations.push({
            attempt: attempts,
            request,
            startedAt: callStartedAt,
            endedAt: deps.now(),
            usage: attempt.usage,
            result: generationResult(attempt.outcome),
          });
        }
        usage = addUsage(usage, attempt.usage);
        const cost = costMicroUsd(model, attempt.billedUsage);
        if (cost > 0) await deps.guards.addSpend(spendDay(deps.now()), cost);
        const { outcome } = attempt;
        if (outcome.kind === "completed") return { outcome, remaining };
        if (outcome.kind === "cancelled") throw cancelled();
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
          throw cancelled();
        }
      }
    };

    // The turn in steps (`steps.ts`): each reply that stops for change calls
    // is answered and the model goes on, until it explains the proposal, asks
    // a question, or stops on its own. Each step's text reaches the producer
    // as its own paragraph as it streams.
    const maxSteps = limits.maxSteps ?? ASSISTANT_MAX_STEPS;
    // A proposal written in one response (GRV-142): a step that would end
    // the turn with a call that would be refused goes on so the model can
    // fix it, and the turn takes at most MAX_CHANGE_STEPS steps of changes,
    // steps fixing refused calls aside.
    const oneResponse = tactics.oneResponseProposal === "on";
    let changeSteps = 0;
    let fixing = false;
    let messages = prepared.request.messages;
    const texts: string[] = [];
    const calls: AssistantToolCall[] = [];
    let requestsRemaining = 0;
    let stopReason: AssistantStopReason;
    // What a recommendation may be aimed at: the project's tracks and pads,
    // and those the turn's kept change calls make (GRV-129).
    let targets = contextTargets(turn.context);
    // Each change call the turn accepts goes to the browser as it is
    // accepted, so the card can show it and the producer apply it (GRV-144).
    let parts = 0;
    const streamParts = async (accepted: readonly AssistantToolCall[]) => {
      for (const call of accepted) {
        if (!isProposalPart(call)) continue;
        const part = { index: parts, toolsetVersion: ASSISTANT_TOOLSET_VERSION, call };
        parts += 1;
        await options.onChunk({ type: "text", text: "", part });
      }
    };
    for (let step = 1; ; step += 1) {
      const said = texts.some((text) => text.trim().length > 0);
      const { outcome, remaining } = await callProvider(
        { ...prepared.request, tools, messages },
        said ? paragraphAfter(options) : options,
      );
      requestsRemaining = remaining;
      // Cut off before it finished: whatever it was proposing or asking is
      // gone (`StreamReader.result`), and its text may stop mid-sentence.
      // Said as a failure, not passed off as a reply that did nothing.
      if (outcome.stopReason === "max_tokens") {
        throw new AssistantGatewayError("reply_too_long", TOO_LONG_MESSAGE);
      }
      texts.push(outcome.text);
      // The bundle was not enough (GRV-143): the step runs again, the same
      // messages with every tool, and does not count as a step. Its calls
      // are dropped; any text it streamed has been said.
      if (narrowed && outcome.toolCalls.some(isNeedMoreToolsCall)) {
        tools = prepared.everything;
        narrowed = false;
        bundleFallback = "need_more_tools";
        step -= 1;
        continue;
      }
      // A call to a tool the bundle did not offer is taken as any call is,
      // and every later step offers every tool, so the conversation it sends
      // back names only tools the request carries.
      if (narrowed && outcome.toolCalls.some((call) => !offers(tools, call.name))) {
        tools = prepared.everything;
        narrowed = false;
        bundleFallback = "unoffered_tool";
      }
      const changes: boolean = outcome.toolCalls.some(isChangeCall);
      const overLimit: boolean =
        oneResponse && changes && !fixing && changeSteps >= MAX_CHANGE_STEPS;
      // Whether the step is the last is settled before it is answered, so a
      // last step's notes are numbered once, by `expandCalls`.
      const refused =
        misaimedIn(outcome.toolCalls, targets) +
        (oneResponse ? refusedIn(outcome.toolCalls, notes) : 0) +
        (overLimit ? 1 : 0);
      const goesOn =
        continuesAfter(outcome.stopReason, outcome.toolCalls) ||
        goesOnToRefuse(outcome.stopReason, outcome.toolCalls, refused);
      // The last step allowed hands its calls on as they came, as a turn of
      // one call does: the browser refuses whatever does not fit. Change
      // calls past the limit are left out: the proposal is what came before.
      if (!goesOn || step >= maxSteps) {
        const handed = overLimit
          ? outcome.toolCalls.filter((entry) => !isChangeCall(entry))
          : outcome.toolCalls;
        const expanded = expandCalls(handed, notes);
        calls.push(...expanded);
        await streamParts(expanded);
        // A turn whose steps made calls stopped for them, as one call's would.
        stopReason = calls.length > 0 ? "tool_use" : outcome.stopReason;
        break;
      }
      const answered = answerStep(
        outcome.toolCalls,
        targets,
        notes,
        overLimit ? { refuseChanges: CHANGE_STEPS_SPENT } : {},
      );
      targets = answered.targets;
      calls.push(...answered.kept);
      await streamParts(answered.kept);
      if (changes && !fixing && !overLimit) changeSteps += 1;
      // The next step fixes this one's refusals; one told the limit is spent
      // has nothing to fix.
      fixing = !overLimit && answered.results.some((result) => result.is_error);
      messages = [
        ...messages,
        { role: "assistant", content: outcome.content },
        { role: "user", content: answered.results },
      ];
    }

    // An option's preview takes notes as the proposal does, written out in
    // a counter of their own (`compactNotes.ts`, GRV-131).
    const asked = askOf(calls);
    const ask = asked && expandAskPreviews(asked, idStem, stepStrings);
    // Every search that turns up no video YouTube vouches for is dropped,
    // never shown unchecked (ADR 0009 decision 5).
    checked = await checkVideoCalls(calls, deps.findVideo, options.signal);
    if (options.signal.aborted) throw cancelled();
    const replyText = texts.filter((text) => text.trim().length > 0).join(PARAGRAPH);
    // Words that lead into a dropped video are not left standing alone.
    const note = droppedVideoNote(replyText, checked);
    if (note) await options.onChunk({ type: "text", text: note });
    const text = replyText + note;
    finish("completed", stopReason);
    const proposal = proposalOf(turn, calls);
    await keepTranscript(deps, uid, caller, turn, startedAt, {
      text,
      stopReason,
      proposal,
      model: model.id,
    });
    await trace("completed");
    return {
      text,
      stopReason,
      proposal,
      ask,
      videos: checked.videos,
      model: model.id,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      requestsRemaining,
    };
  } catch (error) {
    if (error instanceof AssistantGatewayError) {
      finish(error.code, null);
      await trace(error.code);
      throw error;
    }
    // Not a known failure (a store that could not be reached, a bug): logged
    // as such, and left for the function to report as an internal error.
    finish("internal_error", null);
    await trace("internal_error");
    throw error;
  } finally {
    stopHeartbeat();
  }
}
