/**
 * The provider request, built per model (ADR 0006 decision 3).
 *
 * The models under evaluation do not take the same body: Claude Sonnet 5
 * thinks adaptively and takes `output_config.effort`; Claude Haiku 4.5
 * rejects `effort` and wants a thinking budget instead. The shape comes from
 * the model's {@link AssistantModelProfile}, never from the model ID alone,
 * so changing {@link ASSISTANT_MODEL_ID} can never send one model the
 * other's request.
 *
 * The body is plain data in the Messages API's wire shape. The Cloud Function
 * hands it to the provider's SDK as it is, and the typecheck there holds this
 * shape to the SDK's own parameter type.
 *
 * Every turn offers the model the assistant's tool set (GRV-4, `tools.ts`),
 * so it can answer a request to change the song with a proposal, and
 * `explain_change`, which says what that proposal is for. The tool
 * set's version is not on the wire (the Messages API has nowhere to put it);
 * the gateway stamps it on the proposal it returns instead.
 *
 * Two prompt-cache breakpoints (the pattern the Messages API recommends for a
 * tool loop): one on the static system prompt, so the tools and the prompt
 * are read from the cache on every turn after the first in five minutes,
 * and the request's top-level `cache_control`, which caches up to the last
 * block and moves forward as a turn takes its steps (`gateway.ts`), so each
 * step reads everything the step before it sent.
 *
 * Two settings keep a long turn audible to the gateway's inactivity timeout
 * (GRV-6's first live run went silent for a minute on its largest proposals):
 *
 * - **Thinking is summarized.** Adaptive thinking defaults to `display:
 *   "omitted"`, which streams no thinking at all; a summary streams as
 *   thinking deltas the gateway sees but never forwards as reply text.
 * - **Tool input streams eagerly.** Without `eager_input_streaming` the API
 *   holds a tool's input back until it is whole, so a large proposal arrives
 *   after a long silence. With it the API no longer validates that input, so
 *   one that does not parse is returned as it came (`streamEvents.ts`) and
 *   refused by `validateProposal` like any other invalid call.
 */
import type { AssistantModelProfile } from "./config";
import { TACTIC_DEFAULTS, type TacticValues } from "./tactics";
import type { AssistantToolDefinition } from "./tools";

/** A prompt-cache breakpoint: the prefix up to and including its block is cached. */
export interface ProviderCacheControl {
  readonly type: "ephemeral";
}

export interface ProviderTextBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: ProviderCacheControl;
}

/**
 * A block of the assistant's own reply, sent back unchanged when a turn
 * continues after its tool calls (`gateway.ts`). Thinking keeps its signature.
 */
export type ProviderAssistantBlock =
  | ProviderTextBlock
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

/** What the gateway answers one tool call with when the turn continues. */
export interface ProviderToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type ProviderMessage =
  | {
      readonly role: "user";
      readonly content: string | readonly ProviderToolResultBlock[];
    }
  | {
      readonly role: "assistant";
      readonly content: string | readonly ProviderAssistantBlock[];
    };

/** A tool's input schema: a JSON Schema object, as the API requires. */
export interface ProviderToolInputSchema {
  readonly type: "object";
  readonly [keyword: string]: unknown;
}

/** One tool, in the Messages API's wire shape. */
export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ProviderToolInputSchema;
  /** Streams the input as it is generated, unvalidated, rather than whole at the end. */
  readonly eager_input_streaming: true;
}

export type ProviderThinking =
  | { readonly type: "adaptive"; readonly display: "summarized" }
  | { readonly type: "enabled"; readonly budget_tokens: number };

export interface ProviderMessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly system: readonly ProviderTextBlock[];
  readonly messages: readonly ProviderMessage[];
  /**
   * Mutable only because the SDK's parameter type is: the Cloud Function
   * spreads this body into it as it is.
   */
  readonly tools: ProviderTool[];
  readonly thinking: ProviderThinking;
  readonly output_config?: { readonly effort: TacticValues["thinkingEffort"] };
  /** Automatic caching: a breakpoint on the last cacheable block, moving with the turn. */
  readonly cache_control: ProviderCacheControl;
  /** A pseudonymous ID for the account, for the provider's abuse detection. */
  readonly metadata: { readonly user_id: string };
}

export interface ProviderRequestParts {
  readonly system: readonly ProviderTextBlock[];
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderTool[];
  readonly pseudonymousUserId: string;
}

/** What any offered tool has, a proposal tool or `ask_producer` (GRV-42). */
export type OfferedTool = Pick<
  AssistantToolDefinition,
  "name" | "description" | "inputSchema"
>;

/** The assistant's tools in the wire shape, in the order they are offered. */
export function providerTools(tools: readonly OfferedTool[]): ProviderTool[] {
  return tools.map((tool) => {
    if (tool.inputSchema.type !== "object") {
      throw new TypeError(`Tool "${tool.name}" does not take an object`);
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as ProviderToolInputSchema,
      eager_input_streaming: true,
    };
  });
}

/**
 * The request body for one provider call to `model`, shaped by the turn's
 * tactics (`tactics.ts`, GRV-110): production's defaults unless an eval or an
 * experiment says otherwise. An adaptive model thinks as hard as
 * `thinkingEffort` says; a budget one has no effort to set.
 */
export function buildProviderRequest(
  model: AssistantModelProfile,
  parts: ProviderRequestParts,
  tactics: TacticValues = TACTIC_DEFAULTS,
): ProviderMessagesRequest {
  const base = {
    model: model.id,
    max_tokens: model.maxOutputTokens,
    stream: true as const,
    system: withStaticBreakpoint(parts.system),
    messages: parts.messages,
    cache_control: CACHE,
    tools: [...parts.tools],
    metadata: { user_id: parts.pseudonymousUserId },
  };
  switch (model.thinking.kind) {
    case "adaptive":
      return {
        ...base,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: tactics.thinkingEffort },
      };
    case "budget":
      return {
        ...base,
        thinking: { type: "enabled", budget_tokens: model.thinking.budgetTokens },
      };
  }
}

const CACHE: ProviderCacheControl = { type: "ephemeral" };

/**
 * The system blocks with a cache breakpoint on the first, the prompt itself,
 * which is the same for every turn and every account. The tools render
 * before it, so the one breakpoint caches both: about 30k tokens that every
 * turn would otherwise pay for in full. The project, the library and the
 * turn's ID stem after it change from turn to turn.
 */
function withStaticBreakpoint(
  system: readonly ProviderTextBlock[],
): readonly ProviderTextBlock[] {
  const [first, ...rest] = system;
  return first ? [{ ...first, cache_control: CACHE }, ...rest] : system;
}

/**
 * Whether `request` continues a turn after its tool calls (`gateway.ts`):
 * its last message answers them rather than being the producer's words.
 */
export function continuesTurn(
  request: Pick<ProviderMessagesRequest, "messages">,
): boolean {
  const last = request.messages[request.messages.length - 1];
  return last?.role === "user" && typeof last.content !== "string";
}
