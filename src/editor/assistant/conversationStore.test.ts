import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantAsk } from "../../assistant/ask";
import { FOLLOW_UP_MESSAGE, FOLLOW_UP_TITLE } from "../../assistant/followUp";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { hostileStorage, memoryStorage } from "../../testing/storage";
import type { AssistantScope } from "./assistantScope";
import {
  type ConversationStore,
  conversationStorageKey,
  createConversationStore,
  parseConversation,
  restoreOrigin,
  serializeConversation,
} from "./conversationStore";
import {
  type UseAssistantConversationOptions,
  useAssistantConversation,
} from "./useAssistantConversation";

const project = createSliceFixtureProject();
const scope: AssistantScope = {
  level: "track",
  label: "BD",
  catalogScope: "track",
  selection: null,
  track: project.song.tracks[0] ?? null,
};
const ask: AssistantAsk = {
  id: "toolu_1",
  question: "Which kick?",
  options: [{ label: "Punchy" }, { label: "Soft" }],
  multiSelect: false,
};
const KEY = conversationStorageKey("u1", "prj_1");

/** One editor's conversation over `store`: mount it, and dispose it as a reload would. */
function mount(
  store: ConversationStore,
  key = () => KEY as string | null,
  initial: Project | null = project,
  extra: Partial<UseAssistantConversationOptions> = {},
) {
  const client = createFakeAssistantClient();
  const [current, setCurrent] = createSignal<Project | null>(initial);
  let conversation: ReturnType<typeof useAssistantConversation> | undefined;
  const dispose = createRoot((dispose) => {
    conversation = useAssistantConversation({
      client: async () => client,
      project: current,
      scope: () => scope,
      canSend: () => true,
      analytics: () =>
        new Analytics({
          transport: createRecordingTransport(),
          storage: memoryStorage(),
        }),
      persistence: { key, store },
      ...extra,
    });
    return dispose;
  });
  flush();
  if (!conversation) throw new Error("no conversation");
  return { conversation, client, dispose, setProject: setCurrent };
}

/** A conversation whose one reply asked {@link ask}, then unmounted. */
async function askedThenReloaded(store: ConversationStore) {
  const first = mount(store);
  first.conversation.send("Help with the kick");
  await vi.waitFor(() => expect(first.client.turns).toHaveLength(1));
  first.client.last().text("Two ideas.");
  first.client.last().emit({ type: "ask", ask });
  first.client.last().done();
  flush();
  expect(first.conversation.pendingAsk()?.ask).toEqual(ask);
  return first;
}

describe("the conversation across a reload (GRV-42)", () => {
  it("brings back what was said and the question still waiting", async () => {
    const store = createConversationStore(memoryStorage());
    const first = await askedThenReloaded(store);
    const before = first.conversation.entries();
    first.dispose();

    const second = mount(store);
    expect(second.conversation.entries()).toEqual(before);
    expect(second.conversation.pendingAsk()).toMatchObject({
      ask,
      replyId: before[1]?.id,
      asked: project,
    });

    // The answer carries on the same conversation: the turn resends it all.
    expect(second.conversation.answerAsk({ picked: [0], text: "" })).toBe(true);
    await vi.waitFor(() => expect(second.client.turns).toHaveLength(1));
    const sent = second.client.last().request.messages;
    expect(sent[0]).toEqual({ role: "user", text: "Help with the kick" });
    expect(sent[1]?.text).toContain("Which kick?");
    expect(sent.at(-1)?.text).toContain("Punchy");
    // New entries never reuse a restored ID.
    const ids = second.conversation.entries().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    second.dispose();
  });

  it("waits for the project before restoring", async () => {
    const store = createConversationStore(memoryStorage());
    (await askedThenReloaded(store)).dispose();
    const late = mount(store, () => KEY, null);
    // Nothing loaded yet: nothing restored, and the stored copy is untouched.
    expect(late.conversation.entries()).toEqual([]);
    expect(store.load(KEY)?.pendingAsk?.ask).toEqual(ask);
    late.setProject(project);
    flush();
    expect(late.conversation.pendingAsk()?.ask).toEqual(ask);
    late.dispose();
  });

  it("does not bring back a question that was dismissed", async () => {
    const store = createConversationStore(memoryStorage());
    const first = await askedThenReloaded(store);
    first.conversation.dismissAsk();
    flush();
    first.dispose();

    const second = mount(store);
    expect(second.conversation.entries()).toHaveLength(2);
    expect(second.conversation.pendingAsk()).toBeNull();
    second.dispose();
  });

  it("does not bring back a question that was answered", async () => {
    const store = createConversationStore(memoryStorage());
    const first = await askedThenReloaded(store);
    expect(first.conversation.answerAsk({ picked: [1], text: "" })).toBe(true);
    await vi.waitFor(() => expect(first.client.turns).toHaveLength(2));
    first.client.last().text("Soft it is.");
    first.client.last().done();
    flush();
    first.dispose();

    const second = mount(store);
    expect(second.conversation.pendingAsk()).toBeNull();
    expect(second.conversation.entries().map((entry) => entry.kind)).toEqual([
      "message",
      "reply",
      "message",
      "reply",
    ]);
    second.dispose();
  });

  it("keeps one conversation per account and project", async () => {
    const store = createConversationStore(memoryStorage());
    (await askedThenReloaded(store)).dispose();
    const other = mount(store, () => conversationStorageKey("u2", "prj_1"));
    expect(other.conversation.entries()).toEqual([]);
    expect(other.conversation.pendingAsk()).toBeNull();
    other.dispose();
  });

  it("keeps nothing without a key", async () => {
    const storage = memoryStorage();
    const first = mount(createConversationStore(storage), () => null);
    first.conversation.send("Hi");
    await vi.waitFor(() => expect(first.client.turns).toHaveLength(1));
    first.client.last().text("Hello.");
    first.client.last().done();
    flush();
    expect(storage.length).toBe(0);
    first.dispose();
  });

  it("starts empty when what is stored is corrupt or an older shape", () => {
    for (const raw of [
      "{not json",
      JSON.stringify({ version: 0, entries: [], pendingAskReplyId: null }),
      JSON.stringify({
        version: 1,
        entries: [{ kind: "proposal", id: "x" }],
        pendingAskReplyId: null,
      }),
      JSON.stringify({
        version: 1,
        entries: [{ kind: "reply", id: "r", text: "", stopped: false, ask: { id: "a" } }],
        pendingAskReplyId: "r",
      }),
    ]) {
      expect(parseConversation(raw)).toBeNull();
      const storage = memoryStorage();
      storage.setItem(KEY, raw);
      const mounted = mount(createConversationStore(storage));
      expect(mounted.conversation.entries()).toEqual([]);
      expect(mounted.conversation.pendingAsk()).toBeNull();
      mounted.dispose();
    }
  });

  it("keeps a reply's transcript turn and rating, but not its turn of the old session (GRV-103)", () => {
    const stored = parseConversation(
      serializeConversation(
        [
          {
            kind: "reply",
            id: "entry-2",
            text: "Fine.",
            streaming: false,
            stopped: false,
            turnId: "turn-00000001",
            sessionTurn: { session: 1, index: 1 },
            rating: "down",
          },
        ],
        null,
      ),
    );
    expect(stored?.entries).toEqual([
      {
        kind: "reply",
        id: "entry-2",
        text: "Fine.",
        streaming: false,
        stopped: false,
        turnId: "turn-00000001",
        rating: "down",
      },
    ]);
  });

  it("keeps the lesson a reply started, so the next turn still says the call did (GRV-43)", () => {
    const reply = {
      kind: "reply",
      id: "entry-2",
      text: 'Starting "Make a beat" now.',
      streaming: false,
      stopped: false,
      lesson: "beat",
    } as const;
    expect(parseConversation(serializeConversation([reply], null))?.entries).toEqual([
      reply,
    ]);
    // "Finish a track" (GRV-44) is kept the same way.
    const track = { ...reply, lesson: "track" } as const;
    expect(parseConversation(serializeConversation([track], null))?.entries).toEqual([
      track,
    ]);
  });

  it("keeps what became of a reply's proposal, so the next turn still says it (GRV-150)", () => {
    const reply = {
      kind: "reply",
      id: "entry-2",
      text: "I'll add a Closed Hat.",
      streaming: false,
      stopped: false,
      proposal: "cancelled",
    } as const;
    const stored = parseConversation(serializeConversation([reply], null));
    expect(stored?.entries).toEqual([reply]);
  });

  it("keeps the assistant's follow-up as its own, so the log still hides it (GRV-195)", () => {
    const message = {
      kind: "message",
      id: "entry-3",
      text: FOLLOW_UP_TITLE,
      scopeLabel: "BD",
      wire: FOLLOW_UP_MESSAGE,
      automatic: true,
    } as const;
    const stored = parseConversation(serializeConversation([message], null));
    expect(stored?.entries).toEqual([message]);
    // And a card from its turn keeps its turn as the assistant's too.
    const origin = {
      text: FOLLOW_UP_TITLE,
      automatic: true,
      scope: {
        level: "track",
        catalogScope: "track",
        label: "BD",
        selection: null,
        trackId: null,
      },
    } as const;
    expect(restoreOrigin(origin, project).automatic).toBe(true);
  });

  it("carries on in memory when storage throws", async () => {
    const mounted = mount(createConversationStore(hostileStorage()));
    mounted.conversation.send("Hi");
    await vi.waitFor(() => expect(mounted.client.turns).toHaveLength(1));
    mounted.client.last().text("Hello.");
    mounted.client.last().done();
    flush();
    expect(mounted.conversation.entries()).toHaveLength(2);
    mounted.dispose();
  });
});

describe("a proposal still waiting across a reload (GRV-135)", () => {
  const change = {
    id: "toolu_2",
    name: "parameter_set",
    input: { target: "track", trackId: "trk_1", parameter: "volume", value: -6 },
  };
  const proposal = { baseRevision: 0, toolsetVersion: 3, calls: [change] };

  it("comes back with the turn that asked for it, marked as from before the reload", async () => {
    const store = createConversationStore(memoryStorage());
    const first = mount(store, () => KEY, project, { onProposal: vi.fn() });
    first.conversation.send("Turn the kick down");
    await vi.waitFor(() => expect(first.client.turns).toHaveLength(1));
    first.client.last().text("Here's a quieter kick.");
    first.client.last().emit({ type: "proposal", proposal });
    first.client.last().done();
    flush();
    expect(first.conversation.entries().map((entry) => entry.kind)).toEqual([
      "message",
      "reply",
      "proposal",
    ]);
    first.dispose();

    const onProposal = vi.fn();
    const second = mount(store, () => KEY, project, { onProposal });
    expect(second.conversation.entries().map((entry) => entry.kind)).toEqual([
      "message",
      "reply",
      "proposal",
    ]);
    const restored = second.conversation.entries()[2];
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(onProposal).toHaveBeenCalledWith(
      restored?.id,
      proposal,
      expect.objectContaining({
        text: "Turn the kick down",
        restored: true,
        scope: expect.objectContaining({ level: "track", label: "BD" }),
      }),
    );
    // Refresh asks again with the same words and scope.
    expect(second.conversation.refresh(restored?.id ?? "")).toBe(true);
    await vi.waitFor(() => expect(second.client.turns).toHaveLength(1));
    expect(second.client.last().request.messages.at(-1)).toEqual({
      role: "user",
      text: "Turn the kick down",
    });
    expect(second.client.last().request.context.selection?.description).toContain("BD");
    second.dispose();
  });

  it("still records what became of it on the reply that made it (GRV-150)", async () => {
    const store = createConversationStore(memoryStorage());
    const first = mount(store, () => KEY, project, { onProposal: vi.fn() });
    first.conversation.send("Turn the kick down");
    await vi.waitFor(() => expect(first.client.turns).toHaveLength(1));
    first.client.last().text("Here's a quieter kick.");
    first.client.last().emit({ type: "proposal", proposal });
    first.client.last().done();
    flush();
    first.dispose();

    const second = mount(store, () => KEY, project, { onProposal: vi.fn() });
    const [, reply, card] = second.conversation.entries();
    second.conversation.recordProposalOutcome(card?.id ?? "", "cancelled");
    flush();
    const after = second.conversation.entries().find((entry) => entry.id === reply?.id);
    expect(after?.kind === "reply" && after.proposal).toBe("cancelled");
    second.dispose();
  });

  it("keeps the cards still to decide, one origin per turn, and drops decided ones", () => {
    const origin = {
      text: "Add a snare",
      scope,
      remoteChanges: 2,
      turnId: "turn-00000001",
    };
    const pack = {
      id: "pak_1",
      name: "Drums",
      publisher: "Groove",
      version: "1.0.0",
      description: "",
      soundCount: 2,
      inProject: false,
      sounds: [
        {
          id: "snd_1",
          name: "Snare",
          role: "snare",
          type: "one-shot" as const,
          tags: [],
          inProject: false,
        },
        {
          id: "snd_2",
          name: "Hat",
          role: "hat",
          type: "one-shot" as const,
          tags: [],
          inProject: false,
        },
      ],
    };
    const call = {
      id: "toolu_3",
      name: "recommend_sounds",
      input: { packId: "pak_1", soundIds: ["snd_1"], reason: "Fits." },
    };
    const raw = serializeConversation(
      [
        { kind: "message", id: "entry-1", text: "Add a snare", scopeLabel: "BD" },
        { kind: "proposal", id: "entry-2", proposal, origin, replyId: "entry-1" },
        {
          kind: "recommendation",
          id: "entry-3",
          call,
          library: { packs: [pack] },
          origin,
        },
        {
          kind: "recommendation",
          id: "entry-4",
          call,
          library: { packs: [pack] },
          origin,
        },
      ],
      null,
      (entryId) => entryId === "entry-2",
    );
    const stored = parseConversation(raw);
    expect(stored?.entries.map((entry) => entry.id)).toEqual([
      "entry-1",
      "entry-3",
      "entry-4",
    ]);
    const [, first, second] = stored?.entries ?? [];
    if (first?.kind !== "recommendation" || second?.kind !== "recommendation") {
      throw new Error("the sound cards were not kept");
    }
    // One turn, one origin: its cards still come up one at a time.
    expect(first.origin).toBe(second.origin);
    // Only what the card names of the library is kept.
    expect(
      first.library?.packs.map((kept) => kept.sounds.map((sound) => sound.id)),
    ).toEqual([["snd_1"]]);
    const restored = restoreOrigin(first.origin, project);
    expect(restored).toEqual({
      text: "Add a snare",
      turnId: "turn-00000001",
      scope,
      remoteChanges: 0,
      restored: true,
    });
  });

  it("still reads a conversation kept before cards were", () => {
    const stored = parseConversation(
      JSON.stringify({
        version: 1,
        entries: [{ kind: "message", id: "entry-1", text: "Hi", scopeLabel: "BD" }],
        pendingAskReplyId: null,
      }),
    );
    expect(stored?.entries).toHaveLength(1);
  });

  it("drops a card whose turn is not kept", () => {
    expect(
      parseConversation(
        JSON.stringify({
          version: 1,
          entries: [
            { kind: "proposal", id: "entry-2", proposal, origin: 0, replyId: "entry-1" },
          ],
          origins: [],
          pendingAskReplyId: null,
        }),
      ),
    ).toBeNull();
  });
});
