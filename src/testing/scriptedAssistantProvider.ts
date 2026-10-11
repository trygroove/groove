/**
 * A scripted stand-in for the assistant's model provider (#69). Tests describe
 * each provider call as a list of steps (wire events to yield, a failure to
 * throw, a hang) and the provider plays them back in order, one script per
 * call, recording every request it was given. No key, no network.
 */
import type { AssistantContextPayload } from "../assistant/protocol";
import type { AssistantProvider } from "../assistant/provider";
import { ProviderFailure, type ProviderFailureKind } from "../assistant/provider";
import type { ProviderMessagesRequest } from "../assistant/providerRequest";

export type ScriptStep =
  | { readonly event: unknown }
  | { readonly fail: ProviderFailureKind; readonly status?: number }
  /** Never yields again until the call is aborted. */
  | { readonly hang: true }
  /** Pauses this long (real milliseconds) before the next step. */
  | { readonly wait: number }
  /** Ends the stream here, complete or not. */
  | { readonly end: true };

export type CallScript = readonly ScriptStep[];

export interface ScriptedAssistantProvider extends AssistantProvider {
  readonly requests: ProviderMessagesRequest[];
  /** How many calls were aborted while still running. */
  readonly aborted: number;
}

/** The wire events of a whole, successful reply made of `chunks`. */
export function replyEvents(
  chunks: readonly string[],
  options: {
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    withThinking?: boolean;
  } = {},
): ScriptStep[] {
  const thinking: ScriptStep[] = options.withThinking
    ? [
        {
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking" },
          },
        },
        {
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "private reasoning" },
          },
        },
        { event: { type: "content_block_stop", index: 0 } },
      ]
    : [];
  const textIndex = options.withThinking ? 1 : 0;
  return [
    {
      event: {
        type: "message_start",
        message: {
          id: "msg_scripted",
          usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 1 },
        },
      },
    },
    ...thinking,
    {
      event: {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text" },
      },
    },
    ...chunks.map((text) => ({
      event: {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text },
      },
    })),
    { event: { type: "content_block_stop", index: textIndex } },
    {
      event: {
        type: "message_delta",
        delta: { stop_reason: options.stopReason ?? "end_turn" },
        usage: { output_tokens: options.outputTokens ?? 20 },
      },
    },
    { event: { type: "message_stop" } },
  ];
}

/**
 * The wire events of a reply that says `text` and then calls tools, each
 * call's input streamed as JSON in two pieces, ending in `tool_use`.
 */
export function toolUseEvents(
  text: string,
  calls: readonly { readonly name: string; readonly input: unknown }[],
): ScriptStep[] {
  const toolBlocks = calls.flatMap((call, index): ScriptStep[] => {
    const json = JSON.stringify(call.input);
    const half = Math.floor(json.length / 2);
    const blockIndex = index + 1;
    return [
      {
        event: {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: `toolu_${blockIndex}`,
            name: call.name,
            input: {},
          },
        },
      },
      ...[json.slice(0, half), json.slice(half)].map((partial_json) => ({
        event: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json },
        },
      })),
      { event: { type: "content_block_stop", index: blockIndex } },
    ];
  });
  const reply = replyEvents([text], { stopReason: "tool_use" });
  // The text block, then the tool blocks, then the stop.
  return [...reply.slice(0, -2), ...toolBlocks, ...reply.slice(-2)];
}

export function createScriptedAssistantProvider(
  scripts: readonly CallScript[],
): ScriptedAssistantProvider {
  const requests: ProviderMessagesRequest[] = [];
  let aborted = 0;
  let call = 0;
  return {
    requests,
    get aborted() {
      return aborted;
    },
    stream(request, signal) {
      requests.push(request);
      const script = scripts[call] ?? scripts[scripts.length - 1] ?? [];
      call += 1;
      return (async function* () {
        for (const step of script) {
          if (signal.aborted) {
            aborted += 1;
            return;
          }
          if ("event" in step) {
            await Promise.resolve();
            yield step.event;
          } else if ("fail" in step) {
            throw new ProviderFailure(step.fail, step.status ?? null);
          } else if ("wait" in step) {
            await new Promise<void>((resolve) => setTimeout(resolve, step.wait));
          } else if ("hang" in step) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            aborted += 1;
            return;
          } else {
            return;
          }
        }
      })();
    },
  };
}

/** The smallest valid project context a turn can carry: an empty song. */
export const MINIMAL_ASSISTANT_CONTEXT: AssistantContextPayload = {
  projectName: "Song",
  tempo: 120,
  swing: 50,
  timeSignature: { numerator: 4, denominator: 4 },
  totalTicks: 0,
  tracks: [],
  sections: [],
  noteStats: {
    song: {
      noteCount: 0,
      padNoteCount: 0,
      register: null,
      meanVelocity: null,
      notesPerBar: null,
    },
    tracks: [],
  },
  selection: null,
  selectedNotes: null,
};
