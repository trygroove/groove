import { describe, expect, it } from "vitest";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { recordCalls } from "./callTranscript";

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const request = { model: "m", max_tokens: 1, messages: [] } as never;

describe("recordCalls", () => {
  it("rebuilds each call's blocks, tool input parsed, and passes every event through", async () => {
    const scripts = [
      replyEvents(["Hm"], { withThinking: true }),
      toolUseEvents("Done.", [
        { name: "set_volume", input: { trackId: "trk_1", db: -6 } },
      ]),
    ];
    const recorded = recordCalls(createScriptedAssistantProvider(scripts));
    const signal = new AbortController().signal;
    const first = await drain(recorded.provider.stream(request, signal));
    await drain(recorded.provider.stream(request, signal));
    expect(first).toEqual(
      scripts[0].map((step) => ("event" in step ? step.event : null)),
    );

    const [thought, tooled] = recorded.calls();
    expect(thought).toEqual({
      blocks: [
        { kind: "thinking", text: "private reasoning" },
        { kind: "text", text: "Hm" },
      ],
      stopReason: "end_turn",
      complete: true,
    });
    expect(tooled.stopReason).toBe("tool_use");
    expect(tooled.blocks).toEqual([
      { kind: "text", text: "Done." },
      {
        kind: "tool_use",
        id: "toolu_1",
        name: "set_volume",
        input: { trackId: "trk_1", db: -6 },
      },
    ]);
  });

  it("keeps a call cut off mid-tool as far as it got, its input as text", async () => {
    const steps = toolUseEvents("x", [{ name: "t", input: { a: 1 } }]);
    // The stream ends after the first half of the tool's input.
    const firstHalf = steps.findIndex(
      (step) =>
        "event" in step && JSON.stringify(step.event).includes("input_json_delta"),
    );
    const cut = steps.slice(0, firstHalf + 1);
    const recorded = recordCalls(
      createScriptedAssistantProvider([[...cut, { end: true }]]),
    );
    await drain(recorded.provider.stream(request, new AbortController().signal));
    const [call] = recorded.calls();
    expect(call.complete).toBe(false);
    expect(call.blocks[1]).toMatchObject({ kind: "tool_use", name: "t", input: null });
    expect(call.blocks[1]).toHaveProperty("rawInput");
  });
});
