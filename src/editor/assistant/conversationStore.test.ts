import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantAsk } from "../../assistant/ask";
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
} from "./conversationStore";
import { useAssistantConversation } from "./useAssistantConversation";

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
