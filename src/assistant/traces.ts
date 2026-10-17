/**
 * The assistant's traces for PostHog's AI Observability (GRV-126, ADR 0011
 * decision 4): one `$ai_generation` event per provider call, retries
 * included, grouped into one trace per conversation.
 *
 * Firebase-free and SDK-free, like the gateway: the gateway records each call
 * as a {@link GenerationCall}, this module turns a finished turn's calls into
 * events, and the Cloud Function (`functions/src/posthogTraces.ts`) hands them
 * to `posthog-node` through an {@link AssistantTraceSink}.
 *
 * What an event may carry is decided here, once:
 *
 * - **Nothing at all** unless the browser said product analytics is allowed
 *   ({@link traceConsent}). A missing flag is a no.
 * - **Content** (`$ai_input`, `$ai_tools`, `$ai_output_choices`: the system
 *   prompt with the project context, the tools, the messages, the reply and
 *   its tool calls) only when, as well, the account lets Groove keep its
 *   conversations (`permitsRetention`, read from the transcript store on the
 *   same turn). This is the one deliberate exception to "no user text in
 *   events" (ADR 0003, amended by GRV-126): it is scoped to these `$ai_*`
 *   events from the gateway, and the `src/analytics` catalog's rules are
 *   unchanged.
 * - Otherwise codes, counts and durations only, as the turn log
 *   (`telemetry.ts`) carries.
 */
import type {
  AssistantStopReason,
  AssistantToolCall,
  AssistantTurnRequest,
} from "./protocol";
import type { ProviderFailureKind } from "./provider";
import type {
  ProviderAssistantBlock,
  ProviderMessage,
  ProviderMessagesRequest,
  ProviderToolResultBlock,
} from "./providerRequest";
import type { ProviderUsage } from "./streamEvents";
import type { AssistantTurnLog } from "./telemetry";

/** PostHog's event for one model call. */
export const AI_GENERATION_EVENT = "$ai_generation";

/** Who the gateway's model calls go to. */
export const AI_PROVIDER = "anthropic";

/** How one provider call ended, as a trace tells it. */
export type GenerationResult =
  | {
      readonly kind: "completed";
      readonly text: string;
      readonly stopReason: AssistantStopReason;
      readonly toolCalls: readonly AssistantToolCall[];
    }
  | {
      readonly kind: "failed";
      readonly failure: ProviderFailureKind;
      readonly status: number | null;
    }
  | { readonly kind: "timed_out" }
  | { readonly kind: "cancelled" };

/** One provider call, as the gateway saw it. */
export interface GenerationCall {
  /** 1 for the turn's first call; retries and later steps count on. */
  readonly attempt: number;
  readonly request: ProviderMessagesRequest;
  /** Milliseconds since the epoch, either side of the call. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly usage: ProviderUsage;
  readonly result: GenerationResult;
}

/** What every event of one turn shares. */
export interface TraceTurn {
  /** The Firebase UID: the event's `distinct_id`, as the browser identifies it. */
  readonly uid: string;
  /** The conversation's ID, or the turn's own when the request named no session. */
  readonly traceId: string;
  /** What each call's span ID is made from: unique to the turn. */
  readonly turnKey: string;
  /** PostHog's `$session_id` in the browser, linking the trace to its replay. */
  readonly sessionId: string | null;
  readonly model: string;
  readonly promptVersion: string;
  /** How the whole turn ended, in the turn log's codes. */
  readonly outcome: AssistantTurnLog["outcome"];
  /** Team or test traffic, for the project's internal-traffic filter. */
  readonly internal: boolean;
  /** Whether the events may carry the request and the reply. */
  readonly includeContent: boolean;
}

/** One event, ready for `posthog-node`'s `capture`. */
export interface AiGenerationEvent {
  readonly distinctId: string;
  readonly event: typeof AI_GENERATION_EVENT;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * Where a turn's events go. `capture` must not throw or wait: the Cloud
 * Function's sink queues them and sends them in the background.
 */
export interface AssistantTraceSink {
  capture(event: AiGenerationEvent): void;
}

/** Whether the browser said product analytics is allowed. Missing means no. */
export function traceConsent(turn: AssistantTurnRequest): boolean {
  return turn.analytics?.productAnalytics === true;
}

/** The trace a turn belongs to: its conversation, or the turn alone. */
export function traceIdFor(turn: AssistantTurnRequest, fallback: string): string {
  return turn.session?.conversationId ?? fallback;
}

/** The failure a call's `failure_kind` names, or `null` for one that completed. */
function failureKind(result: GenerationResult): string | null {
  switch (result.kind) {
    case "completed":
      return null;
    case "failed":
      return result.failure;
    case "timed_out":
      return "timeout";
    case "cancelled":
      return "cancelled";
  }
}

function httpStatus(result: GenerationResult): number | null {
  if (result.kind === "completed") return 200;
  if (result.kind === "failed") return result.status;
  return null;
}

type InputBlock = ProviderAssistantBlock | ProviderToolResultBlock;

/** A block as the trace shows it: thinking's signature is an opaque blob, left out. */
function inputBlock(block: InputBlock): unknown {
  switch (block.type) {
    case "thinking":
      return { type: "thinking", thinking: block.thinking };
    case "redacted_thinking":
      return { type: "redacted_thinking" };
    default:
      return block;
  }
}

function inputMessage(message: ProviderMessage): unknown {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : (message.content as readonly InputBlock[]).map(inputBlock),
  };
}

/**
 * The request as PostHog shows it: the system prompt (the project context,
 * library and memory are blocks of it) as a `system` message, then the
 * conversation.
 */
export function traceInput(request: ProviderMessagesRequest): unknown[] {
  return [
    {
      role: "system",
      content: request.system.map((block) => ({ type: "text", text: block.text })),
    },
    ...request.messages.map(inputMessage),
  ];
}

/** The reply as PostHog shows it: its text, then its tool calls. */
export function traceOutput(
  result: Extract<GenerationResult, { kind: "completed" }>,
): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        ...(result.text.length > 0 ? [{ type: "text", text: result.text }] : []),
        ...result.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    },
  ];
}

function contentOf(call: GenerationCall): Record<string, unknown> {
  return {
    $ai_input: traceInput(call.request),
    $ai_tools: call.request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    })),
    ...(call.result.kind === "completed"
      ? { $ai_output_choices: traceOutput(call.result) }
      : {}),
  };
}

/** One call's event. */
export function generationEvent(
  turn: TraceTurn,
  call: GenerationCall,
): AiGenerationEvent {
  const status = httpStatus(call.result);
  return {
    distinctId: turn.uid,
    event: AI_GENERATION_EVENT,
    properties: {
      $ai_trace_id: turn.traceId,
      $ai_span_id: `${turn.turnKey}-${call.attempt}`,
      $ai_model: call.request.model,
      $ai_provider: AI_PROVIDER,
      $ai_input_tokens: call.usage.inputTokens,
      $ai_output_tokens: call.usage.outputTokens,
      $ai_cache_read_input_tokens: call.usage.cacheReadInputTokens,
      $ai_cache_creation_input_tokens: call.usage.cacheCreationInputTokens,
      $ai_latency: Math.max(0, call.endedAt - call.startedAt) / 1000,
      $ai_is_error: call.result.kind !== "completed",
      ...(status === null ? {} : { $ai_http_status: status }),
      $ai_stop_reason: call.result.kind === "completed" ? call.result.stopReason : null,
      ...(turn.sessionId ? { $session_id: turn.sessionId } : {}),
      prompt_version: turn.promptVersion,
      outcome: turn.outcome,
      attempt: call.attempt,
      failure_kind: failureKind(call.result),
      // A string, as the browser's events carry it, so one filter covers both.
      internal: String(turn.internal),
      ...(turn.includeContent ? contentOf(call) : {}),
    },
  };
}

/** A turn's events, one per provider call, in the order they were made. */
export function generationEvents(
  turn: TraceTurn,
  calls: readonly GenerationCall[],
): AiGenerationEvent[] {
  return calls.map((call) => generationEvent(turn, call));
}
