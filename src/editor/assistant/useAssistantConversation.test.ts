import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { createRecordingTransport } from "../../analytics/transport";
import { type AssistantAsk, askTranscript } from "../../assistant/ask";
import { ASSISTANT_REQUEST_LIMITS } from "../../assistant/config";
import type { AssistantLibraryContext } from "../../assistant/protocol";
import { RECOMMEND_SOUNDS_TOOL } from "../../assistant/recommendation";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { buildAssistantLibrary } from "../../testing/assistantLibrary";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import type { AssistantScope } from "./assistantScope";
import {
  type AssistantConversation,
  type ConversationEntry,
  historyOf,
  useAssistantConversation,
} from "./useAssistantConversation";

const message = (id: string, text: string): ConversationEntry => ({
  kind: "message",
  id,
  text,
  scopeLabel: "BD",
});
const reply = (id: string, text: string): ConversationEntry => ({
  kind: "reply",
  id,
  text,
  streaming: false,
  stopped: false,
});

describe("the conversation a turn resends", () => {
  it("keeps each message that got a reply, with the reply", () => {
    expect(
      historyOf([
        message("1", "One"),
        reply("2", "Reply"),
        message("3", "Failed"),
        {
          kind: "error",
          id: "4",
          error: { code: "timeout", retryable: true },
          request: null as never,
          origin: null as never,
        },
        message("5", "Stopped early"),
        { kind: "reply", id: "6", text: "", streaming: false, stopped: true },
      ]),
    ).toEqual([
      { role: "user", text: "One" },
      { role: "assistant", text: "Reply" },
    ]);
  });

  it("never resends a reply that failed part-way as the answer (GRV-26)", () => {
    expect(
      historyOf([
        message("1", "Q"),
        {
          kind: "reply",
          id: "2",
          text: "Here is one idea. ",
          streaming: false,
          stopped: false,
          failed: true,
        },
        reply("3", "Here is one idea. Full reply."),
      ]),
    ).toEqual([
      { role: "user", text: "Q" },
      { role: "assistant", text: "Here is one idea. Full reply." },
    ]);
  });

  it("resends a question the reply asked with it, and an answer as what it says (GRV-42)", () => {
    const ask: AssistantAsk = {
      id: "toolu_1",
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: false,
    };
    expect(
      historyOf([
        message("1", "Help"),
        { kind: "reply", id: "2", text: "", streaming: false, stopped: false, ask },
        {
          kind: "message",
          id: "3",
          text: "A",
          scopeLabel: "BD",
          answers: "Which?",
          wire: '[Answer to "Which?"] Picked: A.',
        },
        reply("4", "Going with A."),
      ]),
    ).toEqual([
      { role: "user", text: "Help" },
      { role: "assistant", text: askTranscript(ask) },
      { role: "user", text: '[Answer to "Which?"] Picked: A.' },
      { role: "assistant", text: "Going with A." },
    ]);
  });

  it("leaves room for the new message, in whole exchanges", () => {
    const entries = Array.from({ length: 150 }, (_, index) => [
      message(`m${index}`, `Q${index}`),
      reply(`r${index}`, `A${index}`),
    ]).flat();
    const history = historyOf(entries);
    expect(history.length).toBeLessThan(ASSISTANT_REQUEST_LIMITS.maxMessages);
    expect(history.length % 2).toBe(0);
    expect(history[0]?.role).toBe("user");
    expect(history.at(-1)).toEqual({ role: "assistant", text: "A149" });
  });
});

describe("a conversation that can recommend (GRV-23)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "track",
    label: "BD",
    catalogScope: "track",
    selection: null,
    track: project.song.tracks[0] ?? null,
  };

  function talk(library?: () => Promise<AssistantLibraryContext | null>) {
    const client = createFakeAssistantClient();
    const onProposal = vi.fn();
    const onRecommendation = vi.fn();
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        onProposal,
        onRecommendation,
        ...(library ? { library } : {}),
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    return { conversation, client, onProposal, onRecommendation, dispose };
  }

  it("sends the library with the turn, and none when it will not load", async () => {
    const library = buildAssistantLibrary();
    const loaded = talk(async () => library);
    loaded.conversation.send("Anything dustier?");
    await vi.waitFor(() => expect(loaded.client.turns).toHaveLength(1));
    expect(loaded.client.last().request.library).toEqual(library);
    loaded.dispose();

    const failing = talk(async () => {
      throw new Error("offline");
    });
    failing.conversation.send("Anything dustier?");
    await vi.waitFor(() => expect(failing.client.turns).toHaveLength(1));
    expect(failing.client.last().request.library).toBeUndefined();
    failing.dispose();
  });

  it("takes recommendations out of a proposal: a card each, and the changes as one", async () => {
    const library = buildAssistantLibrary();
    const { conversation, client, onProposal, onRecommendation, dispose } = talk(
      async () => library,
    );
    conversation.send("Dustier, and slower");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    const recommend = { id: "t1", name: RECOMMEND_SOUNDS_TOOL, input: { packId: "x" } };
    const change = { id: "t2", name: "parameter_set", input: {} };
    client.last().emit({
      type: "proposal",
      proposal: { baseRevision: 0, toolsetVersion: 3, calls: [recommend, change] },
    });
    client.last().done();
    flush();
    const kinds = conversation.entries().map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "proposal", "recommendation"]);
    expect(onProposal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ calls: [change] }),
      expect.anything(),
    );
    expect(onRecommendation).toHaveBeenCalledWith(
      expect.any(String),
      recommend,
      library,
      expect.objectContaining({ text: "Dustier, and slower" }),
    );
    // Refresh asks again for a recommendation, in its words.
    const entry = conversation.entries().find((item) => item.kind === "recommendation");
    expect(conversation.refresh(entry?.id ?? "")).toBe(true);
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    expect(client.last().request.messages.at(-1)?.text).toBe("Dustier, and slower");
    dispose();
  });
});
