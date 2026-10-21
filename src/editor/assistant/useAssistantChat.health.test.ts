import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantProposal } from "../../assistant/protocol";
import {
  ASSISTANT_TOOLSET_VERSION,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
} from "../../assistant/tools";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { createFakeRetentionClient } from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "../composition/assistantProposalTarget";
import { EditorSession } from "../composition/EditorSession";
import type { EditorLocation } from "../composition/editorControls";
import { createConversationStore } from "./conversationStore";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";

/**
 * The sad-session detector (GRV-103) wired into a whole chat: a real editor
 * session, proposals applied, undone and turned down through the chat's own
 * cards, a manual clock, and a conversation that moves to another project.
 * `sessionHealth.test.ts` covers the detector's rules; this covers that the
 * chat feeds it every signal, from the right turn, and resets it.
 */

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EXPLANATION = {
  goal: "The beat feels played rather than programmed.",
  technique: "Swing delays every second 16th note, the way a drummer's hand lags.",
};

const SWING: AssistantProposal["calls"] = [
  {
    id: "toolu_1",
    name: "parameter_set",
    input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
  },
  { id: "toolu_2", name: EXPLAIN_TOOL_NAME, input: EXPLANATION },
];

/** A track on a sound the library does not have: a proposal the kernel rejects. */
function missingSound(): AssistantProposal["calls"] {
  const input: Record<string, unknown> = structuredClone(CREATE_EXAMPLES.track);
  input.instrument = {
    kind: "sampler",
    assetId: "ast_NoisePad0000000000001",
    parameters: {},
  };
  return [
    { id: "toolu_7", name: "track_create", input },
    { id: "toolu_8", name: EXPLAIN_TOOL_NAME, input: EXPLANATION },
  ];
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function setUp() {
  const repository = createInMemoryProjectRepository();
  const project = createSliceFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("registered");
  const clock = createManualClock(1_000_000);
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });
  const fake = createFakeAssistantClient();
  const retention = createFakeRetentionClient({ answered: true });
  const track = project.song.tracks[0] ?? null;
  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });
  const [key, setKey] = createSignal<string | null>("conversation:u1:first");
  let chat: AssistantChat | undefined;
  disposers.push(
    createRoot((dispose) => {
      chat = useAssistantChat({
        project: shown,
        view: () => "arrangement",
        sources: () => ({ selection: null, track }),
        account: () => ({ registered: true }),
        expanded: () => true,
        client: async () => fake,
        analytics: () => analytics,
        retention: { client: async () => retention, internal: () => false },
        editor: {
          session: {
            proposalTarget: () => assistantProposalTarget(session),
            beginPreview: (commands) => session.beginPreview(commands),
            onEdit: (listener) => session.subscribeEdits(listener),
            onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
            previewing,
          },
          controls: {
            registry: createControlRegistry(),
            revealControl: vi.fn(() => ({}) as EditorLocation),
            restoreView: vi.fn(),
          },
        },
        conversationKey: key,
        conversationStore: createConversationStore(memoryStorage()),
        clock,
      });
      return dispose;
    }),
  );
  flush();
  await settle();
  if (!chat) throw new Error("the chat did not start");
  const theChat = chat;

  /** Sends a message and answers it with `calls`; returns the card's entry ID. */
  async function propose(
    calls: AssistantProposal["calls"] = SWING,
    baseRevision = session.committedProject.metadata.revision,
  ): Promise<string> {
    expect(theChat.conversation.send("Loosen the beat")).toBe(true);
    await settle();
    fake.last().text("Some swing.");
    fake.last().emit({
      type: "proposal",
      proposal: { baseRevision, toolsetVersion: ASSISTANT_TOOLSET_VERSION, calls },
    });
    fake.last().done();
    flush();
    const card = theChat.conversation
      .entries()
      .findLast((entry) => entry.kind === "proposal");
    if (!card) throw new Error("no proposal card");
    return card.id;
  }

  /** Each `assistant_session_*` event so far, as `started` or `sad:<counts_for>:<reason>`. */
  const health = () =>
    transport.events
      .filter((event) => event.name.startsWith("assistant_session_"))
      .map((event) =>
        event.name === "assistant_session_sad"
          ? `sad:${event.params.counts_for}:${event.params.reason}`
          : "started",
      );

  return { chat: theChat, client: fake, clock, session, setKey, propose, health };
}

describe("a chat's sad sessions (GRV-103)", () => {
  it("counts a proposal rejected as stale", async () => {
    const { session, propose, health } = await setUp();
    await propose(SWING, session.committedProject.metadata.revision + 1);
    expect(health()).toEqual([
      "started",
      "sad:full:proposal_stale",
      "sad:hard:proposal_stale",
    ]);
  });

  it("counts a proposal rejected as invalid", async () => {
    const { propose, health } = await setUp();
    await propose(missingSound());
    expect(health()).toEqual([
      "started",
      "sad:full:proposal_invalid",
      "sad:hard:proposal_invalid",
    ]);
  });

  it("counts a proposal turned down with Cancel, on the full rate only", async () => {
    const { chat, propose, health } = await setUp();
    const card = await propose();
    expect(health()).toEqual(["started"]);
    // The first cancel ends the preview that opened by itself (GRV-193).
    chat.proposals?.cancel(card);
    flush();
    chat.proposals?.cancel(card);
    flush();
    expect(chat.proposals?.card(card)?.status).toBe("cancelled");
    expect(health()).toEqual(["started", "sad:full:proposal_cancelled"]);
  });

  it("counts an apply undone within a minute, and not one undone at 61 seconds", async () => {
    const fast = await setUp();
    const quick = await fast.propose();
    fast.chat.proposals?.apply(quick);
    await settle();
    flush();
    expect(fast.chat.proposals?.card(quick)?.status).toBe("applied");
    fast.clock.advance(60_000);
    fast.chat.proposals?.undo(quick);
    await settle();
    flush();
    expect(fast.chat.proposals?.card(quick)?.status).toBe("undone");
    expect(fast.health()).toEqual(["started", "sad:full:proposal_undone_fast"]);

    const slow = await setUp();
    const late = await slow.propose();
    slow.chat.proposals?.apply(late);
    await settle();
    flush();
    slow.clock.advance(61_000);
    slow.chat.proposals?.undo(late);
    await settle();
    flush();
    expect(slow.chat.proposals?.card(late)?.status).toBe("undone");
    expect(slow.health()).toEqual(["started"]);
  });

  it("starts a new session, under a new conversation, when the project changes", async () => {
    const { chat, client, setKey, health } = await setUp();
    expect(chat.conversation.send("One")).toBe(true);
    await settle();
    client.last().fail({ code: "timeout", retryable: true });
    flush();
    expect(health()).toEqual(["started", "sad:full:turn_error", "sad:hard:turn_error"]);

    setKey("conversation:u1:second");
    flush();
    expect(chat.conversation.send("Two")).toBe(true);
    await settle();
    client.last().fail({ code: "timeout", retryable: true });
    flush();
    expect(health()).toEqual([
      "started",
      "sad:full:turn_error",
      "sad:hard:turn_error",
      "started",
      "sad:full:turn_error",
      "sad:hard:turn_error",
    ]);
    const conversations = client.turns.map(
      (turn) => turn.request.session?.conversationId,
    );
    expect(conversations[0]).toBeDefined();
    expect(conversations[1]).toBeDefined();
    expect(conversations[1]).not.toBe(conversations[0]);
  });

  it("does not count an outcome on the old project's card against the new session", async () => {
    const { chat, client, setKey, propose, health } = await setUp();
    const oldCard = await propose();

    setKey("conversation:u1:second");
    flush();
    expect(chat.conversation.send("Hello")).toBe(true);
    await settle();
    client.last().done();
    flush();
    // The old project's card is turned down after the new conversation began.
    chat.proposals?.cancel(oldCard);
    flush();
    chat.proposals?.cancel(oldCard);
    flush();
    expect(chat.proposals?.card(oldCard)?.status).toBe("cancelled");
    expect(health()).toEqual(["started", "started"]);
  });
});

describe("what the next turn resends of a proposal (GRV-150)", () => {
  /** The assistant's message about the card's turn, as the next turn resends it. */
  async function resent(
    chat: AssistantChat,
    client: ReturnType<typeof createFakeAssistantClient>,
  ) {
    expect(chat.conversation.send("is anything muted right now?")).toBe(true);
    await settle();
    return client.last().request.messages.find((message) => message.role === "assistant")
      ?.text;
  }

  it("says a cancelled proposal changed nothing", async () => {
    const { chat, client, propose } = await setUp();
    const card = await propose();
    // The first cancel ends the preview that opened by itself (GRV-193).
    chat.proposals?.cancel(card);
    flush();
    chat.proposals?.cancel(card);
    flush();
    expect(await resent(chat, client)).toBe(
      "Some swing.\n\n[The producer cancelled this proposal. Nothing in it is in the song.]",
    );
  });

  it("says an applied proposal was applied, and an undone one was undone", async () => {
    const { chat, client, propose } = await setUp();
    const card = await propose();
    chat.proposals?.apply(card);
    await settle();
    flush();
    expect(await resent(chat, client)).toContain("[The producer applied this proposal.");
    client.last().text("Nothing is muted.");
    client.last().done();
    flush();
    chat.proposals?.undo(card);
    await settle();
    flush();
    expect(await resent(chat, client)).toContain(
      "[The producer applied this proposal, then undid it.",
    );
  });

  it("says a proposal still waiting has not been applied", async () => {
    const { chat, client, propose } = await setUp();
    await propose();
    expect(await resent(chat, client)).toContain(
      "[The producer has not applied this proposal.",
    );
  });
});
