/**
 * What the model sent back, call by call (GRV-108): the blocks of each
 * provider call a turn made, rebuilt from the raw wire events, so
 * `bun run assistant:try` can print the whole response, tool calls and their
 * input included, rather than only what the gateway made of it.
 *
 * It wraps the provider and changes nothing it yields: the gateway reads the
 * same stream it would have. A call the gateway abandoned (a retry, a
 * timeout) is kept as far as it got, marked incomplete.
 */
import type { AssistantProvider } from "../provider";

export type TranscriptBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool_use";
      readonly id: string;
      readonly name: string;
      /** The parsed input; null when it did not parse, with the text in `rawInput`. */
      readonly input: unknown;
      readonly rawInput?: string;
    }
  /** A block of a type this does not unpack (`redacted_thinking`, ...). */
  | { readonly kind: "other"; readonly type: string };

/** One provider call: its blocks in order, why it stopped, and whether it ended. */
export interface ProviderCallRecord {
  readonly blocks: readonly TranscriptBlock[];
  readonly stopReason: string | null;
  /** False when the stream stopped before `message_stop`. */
  readonly complete: boolean;
}

interface OpenBlock {
  type: string;
  id: string;
  name: string;
  text: string;
  json: string;
  startInput: unknown;
}

interface OpenCall {
  blocks: Map<number, OpenBlock>;
  stopReason: string | null;
  complete: boolean;
}

type WireEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: {
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
} | null;

function accept(call: OpenCall, raw: unknown): void {
  const event = raw as WireEvent;
  const index = event?.index ?? -1;
  switch (event?.type) {
    case "content_block_start": {
      const block = event.content_block;
      call.blocks.set(index, {
        type: block?.type ?? "unknown",
        id: block?.id ?? "",
        name: block?.name ?? "",
        text: "",
        json: "",
        startInput: block?.input ?? {},
      });
      return;
    }
    case "content_block_delta": {
      const block = call.blocks.get(index);
      if (!block) return;
      block.text += event.delta?.text ?? event.delta?.thinking ?? "";
      block.json += event.delta?.partial_json ?? "";
      return;
    }
    case "message_delta":
      call.stopReason = event.delta?.stop_reason ?? call.stopReason;
      return;
    case "message_stop":
      call.complete = true;
      return;
  }
}

function closeBlock(block: OpenBlock): TranscriptBlock {
  if (block.type === "text") return { kind: "text", text: block.text };
  if (block.type === "thinking") return { kind: "thinking", text: block.text };
  if (block.type !== "tool_use") return { kind: "other", type: block.type };
  if (block.json === "") {
    return { kind: "tool_use", id: block.id, name: block.name, input: block.startInput };
  }
  try {
    return {
      kind: "tool_use",
      id: block.id,
      name: block.name,
      input: JSON.parse(block.json),
    };
  } catch {
    return {
      kind: "tool_use",
      id: block.id,
      name: block.name,
      input: null,
      rawInput: block.json,
    };
  }
}

function closeCall(call: OpenCall): ProviderCallRecord {
  return {
    blocks: [...call.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => closeBlock(block)),
    stopReason: call.stopReason,
    complete: call.complete,
  };
}

/** Wraps `provider` so every call it makes is recorded, block by block. */
export function recordCalls(provider: AssistantProvider): {
  readonly provider: AssistantProvider;
  calls(): ProviderCallRecord[];
} {
  const open: OpenCall[] = [];
  return {
    provider: {
      async *stream(request, signal) {
        const call: OpenCall = { blocks: new Map(), stopReason: null, complete: false };
        open.push(call);
        for await (const raw of provider.stream(request, signal)) {
          accept(call, raw);
          yield raw;
        }
      },
    },
    calls: () => open.map(closeCall),
  };
}
