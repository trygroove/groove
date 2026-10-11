/**
 * Reading and validating the provider's stream (#69: "response validation").
 *
 * Each raw event is checked against the Messages API's shape before the
 * gateway acts on it. An event type this module does not know is skipped, as
 * the API asks clients to do; a known one in the wrong shape is a
 * {@link ProviderFailure} of kind `malformed`, never a silently dropped chunk.
 * The order the events arrive in is checked by {@link StreamReader}.
 *
 * A turn may end in tool calls (GRV-4): the model proposing changes through
 * the tools `tools.ts` offers. Their input arrives as JSON in pieces and is
 * parsed once the turn is complete. The tools stream eagerly
 * (`providerRequest.ts`), so the API no longer checks that input: one that is
 * not a JSON object is the model's mistake, not a broken stream, and is
 * returned as it came for the browser to refuse. Nothing here decides whether
 * a call is allowed — the browser validates the proposal against the open
 * project.
 */
import { z } from "zod";
import { ESTIMATED_CHARS_PER_TOKEN } from "./config";
import type { AssistantStopReason, AssistantToolCall } from "./protocol";
import { ProviderFailure } from "./provider";

const tokens = z.int().min(0);

/** Token counts as the provider reports them; any of them may be absent. */
const usageSchema = z.looseObject({
  input_tokens: tokens.nullish(),
  output_tokens: tokens.nullish(),
  cache_creation_input_tokens: tokens.nullish(),
  cache_read_input_tokens: tokens.nullish(),
});

/** The content blocks a turn can contain. Anything else is unexpected. */
const ALLOWED_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/** What a `tool_use` block must name when it starts. */
const toolUseStartSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});

const knownEventSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("message_start"),
    message: z.looseObject({ usage: usageSchema }),
  }),
  z.looseObject({
    type: z.literal("content_block_start"),
    index: z.int().min(0),
    content_block: z.looseObject({ type: z.string() }),
  }),
  z.looseObject({
    type: z.literal("content_block_delta"),
    index: z.int().min(0),
    delta: z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      thinking: z.string().optional(),
      partial_json: z.string().optional(),
    }),
  }),
  z.looseObject({ type: z.literal("content_block_stop"), index: z.int().min(0) }),
  z.looseObject({
    type: z.literal("message_delta"),
    delta: z.looseObject({ stop_reason: z.string().nullable() }),
    usage: usageSchema.optional(),
  }),
  z.looseObject({ type: z.literal("message_stop") }),
  z.looseObject({ type: z.literal("ping") }),
]);

const KNOWN_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

/** The stop reasons a turn may end with. */
const ACCEPTED_STOP_REASONS: ReadonlySet<string> = new Set<AssistantStopReason>([
  "end_turn",
  "max_tokens",
  "refusal",
  "tool_use",
]);

/** A tool call while its input is still arriving. */
interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  json: string;
}

/** Billable token counts for one provider call. */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export const NO_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function mergeUsage(
  previous: ProviderUsage,
  reported: z.infer<typeof usageSchema> | undefined,
): ProviderUsage {
  if (!reported) return previous;
  return {
    inputTokens: reported.input_tokens ?? previous.inputTokens,
    outputTokens: reported.output_tokens ?? previous.outputTokens,
    cacheCreationInputTokens:
      reported.cache_creation_input_tokens ?? previous.cacheCreationInputTokens,
    cacheReadInputTokens:
      reported.cache_read_input_tokens ?? previous.cacheReadInputTokens,
  };
}

const malformed = () => new ProviderFailure("malformed");

/**
 * Follows one provider call's stream: validates each event, checks they come
 * in order, collects the reply's text and the usage, and says when the
 * message is complete. Text deltas come back from {@link accept} for the
 * caller to forward.
 */
export class StreamReader {
  private started = false;
  private finished = false;
  private stopReason: AssistantStopReason | null = null;
  private readonly blocks = new Map<number, string>();
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private text = "";
  private currentUsage: ProviderUsage = NO_USAGE;
  /** Characters of reply and thinking streamed so far. */
  private streamedChars = 0;
  /** Whether `message_delta` carried the call's final output count. */
  private outputCounted = false;

  /** Validates one raw event; returns the text it adds, if any. */
  accept(raw: unknown): string | null {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== "string") throw malformed();
    if (!KNOWN_TYPES.has(type)) return null;
    const parsed = knownEventSchema.safeParse(raw);
    if (!parsed.success) throw malformed();
    const event = parsed.data;
    if (this.finished) throw malformed();
    if (event.type === "ping") return null;
    if (event.type === "message_start") {
      if (this.started) throw malformed();
      this.started = true;
      this.currentUsage = mergeUsage(this.currentUsage, event.message.usage);
      return null;
    }
    if (!this.started) throw malformed();
    switch (event.type) {
      case "content_block_start":
        if (!ALLOWED_BLOCKS.has(event.content_block.type)) throw malformed();
        if (this.blocks.has(event.index)) throw malformed();
        if (event.content_block.type === "tool_use") {
          const start = toolUseStartSchema.safeParse(event.content_block);
          if (!start.success) throw malformed();
          this.toolCalls.set(event.index, {
            id: start.data.id,
            name: start.data.name,
            json: "",
          });
        }
        this.blocks.set(event.index, event.content_block.type);
        return null;
      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        if (block === undefined) throw malformed();
        this.streamedChars +=
          (event.delta.text?.length ?? 0) +
          (event.delta.thinking?.length ?? 0) +
          (event.delta.partial_json?.length ?? 0);
        const toolCall = this.toolCalls.get(event.index);
        if (toolCall) {
          if (
            event.delta.type !== "input_json_delta" ||
            event.delta.partial_json === undefined
          ) {
            throw malformed();
          }
          toolCall.json += event.delta.partial_json;
          return null;
        }
        if (block !== "text" || event.delta.type !== "text_delta") return null;
        if (event.delta.text === undefined) throw malformed();
        this.text += event.delta.text;
        return event.delta.text;
      }
      case "content_block_stop":
        if (!this.blocks.has(event.index)) throw malformed();
        return null;
      case "message_delta": {
        const reason = event.delta.stop_reason;
        if (reason !== null) {
          if (!ACCEPTED_STOP_REASONS.has(reason))
            throw new ProviderFailure("unsupported_stop");
          this.stopReason = reason as AssistantStopReason;
        }
        this.currentUsage = mergeUsage(this.currentUsage, event.usage);
        if (typeof event.usage?.output_tokens === "number") this.outputCounted = true;
        return null;
      }
      case "message_stop":
        if (this.stopReason === null) throw malformed();
        this.finished = true;
        return null;
    }
  }

  /** Whether `message_stop` has arrived. */
  get complete(): boolean {
    return this.finished;
  }

  /** What the call has used so far, the provider's own figures. */
  get usage(): ProviderUsage {
    return this.currentUsage;
  }

  /**
   * What the call should be charged against the spend ceiling. The provider's
   * figures once it has given its final output count; before then (a call
   * cancelled, timed out or broken mid-stream) the output is estimated from
   * the text and thinking streamed so far, which the provider bills for even
   * though it never reported it.
   */
  get billableUsage(): ProviderUsage {
    if (this.outputCounted) return this.currentUsage;
    const estimated = Math.ceil(this.streamedChars / ESTIMATED_CHARS_PER_TOKEN);
    return {
      ...this.currentUsage,
      outputTokens: Math.max(this.currentUsage.outputTokens, estimated),
    };
  }

  /** Whether any of the reply's text has been seen. */
  get hasText(): boolean {
    return this.text.length > 0;
  }

  /**
   * The validated reply, once complete. A turn that ended normally with no
   * text at all is not a reply, and one that stopped for its tool calls must
   * have made at least one.
   * Tool calls in a turn that stopped for any other reason (cut off at
   * `max_tokens`, say) are dropped: a proposal that may be missing its end is
   * not one to show.
   */
  result(): {
    text: string;
    stopReason: AssistantStopReason;
    toolCalls: AssistantToolCall[];
  } {
    if (!this.finished || this.stopReason === null) throw malformed();
    if (this.stopReason === "end_turn" && this.text.trim().length === 0)
      throw malformed();
    if (this.stopReason !== "tool_use") {
      return { text: this.text, stopReason: this.stopReason, toolCalls: [] };
    }
    if (this.toolCalls.size === 0) throw malformed();
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        input: parseInput(call.json),
      }));
    return { text: this.text, stopReason: this.stopReason, toolCalls };
  }
}

/**
 * A tool call's streamed input: the JSON it parses to (nothing at all is
 * `{}`), or, when it does not parse, the text as it came. Either way the
 * browser's `validateProposal` refuses anything that is not a valid payload,
 * so input that is broken or cut short is a refused proposal, never a
 * malformed reply.
 */
function parseInput(json: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
