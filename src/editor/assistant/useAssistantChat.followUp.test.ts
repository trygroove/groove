import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { FOLLOW_UP_MESSAGE } from "../../assistant/followUp";
import { proposalNote } from "../../assistant/history";
import type { AssistantProposal, AssistantToolCall } from "../../assistant/protocol";
import { ASSISTANT_TOOLSET_VERSION, EXPLAIN_TOOL_NAME } from "../../assistant/tools";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING, TRACK_VOLUME } from "../../domain/parameters";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { createManualScheduler } from "../../shared/scheduler";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "../composition/assistantProposalTarget";
import { EditorSession } from "../composition/EditorSession";
import type { EditorLocation } from "../composition/editorControls";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";
import { FOLLOW_UP_DELAY_MS } from "./useFollowUp";

/**
 * The assistant's follow-up after an Apply (GRV-195), against a real editor
 * session: one turn per Apply, none for a dismissal, one for a run of
 * applies, and a follow-up that fails leaves the change it followed in the
 * song.
 */

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EXPLAIN: AssistantToolCall = {
  id: "toolu_why",
  name: EXPLAIN_TOOL_NAME,
  input: {
    goal: "The beat feels played rather than programmed.",
    technique: "Swing delays every second 16th note.",
  },
};
const SWING: AssistantToolCall = {
  id: "toolu_swing",
  name: "parameter_set",
  input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
};

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
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });
  const client = createFakeAssistantClient();
  const scheduler = createManualScheduler();
  const track = project.song.tracks[0];
  if (!track) throw new Error("the fixture has no track");
  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });
  let chat: AssistantChat | undefined;
  disposers.push(
    createRoot((dispose) => {
      chat = useAssistantChat({
        project: shown,
        view: () => "arrangement",
        sources: () => ({ selection: null, track }),
        account: () => ({ registered: true }),
        expanded: () => true,
        client: async () => client,
        analytics: () => analytics,
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
        clock: createManualClock(1_000_000),
        scheduler,
      });
      return dispose;
    }),
  );
  flush();
  await settle();
  if (!chat) throw new Error("the chat did not start");
  const theChat = chat;

  /** Sends a message and answers it with one whole proposal; returns its card. */
  async function propose(calls: readonly AssistantToolCall[] = [SWING]): Promise<string> {
    expect(theChat.conversation.send("Loosen the beat")).toBe(true);
    await settle();
    client.last().text("Some swing.");
    client.last().emit({
      type: "proposal",
      proposal: {
        baseRevision: session.committedProject.metadata.revision,
        toolsetVersion: ASSISTANT_TOOLSET_VERSION,
        calls: [...calls, EXPLAIN],
      } satisfies AssistantProposal,
    });
    client.last().done();
    flush();
    return lastCard();
  }

  function lastCard(): string {
    const card = theChat.conversation
      .entries()
      .findLast((entry) => entry.kind === "proposal");
    if (!card) throw new Error("no proposal card");
    return card.id;
  }

  /** Lets the quiet after an Apply run out, and the follow-up's client load. */
  async function wait(ms = FOLLOW_UP_DELAY_MS) {
    scheduler.advance(ms);
    flush();
    await settle();
    flush();
  }

  const sent = () =>
    transport.events
      .filter((event) => event.name === "assistant_message_sent")
      .map((event) => event.params?.automatic);
  const volume = (value: number): AssistantToolCall => ({
    id: `toolu_volume_${value}`,
    name: "parameter_set",
    input: {
      target: { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
      value,
    },
  });

  return {
    chat: theChat,
    client,
    session,
    transport,
    propose,
    lastCard,
    wait,
    sent,
    volume,
  };
}

describe("the assistant's follow-up after an Apply (GRV-195)", () => {
  it("takes exactly one turn by itself after a proposal is applied", async () => {
    const { chat, client, propose, wait, sent, transport } = await setUp();
    const card = await propose();
    chat.proposals?.apply(card);
    flush();
    expect(client.turns).toHaveLength(1);

    await wait(FOLLOW_UP_DELAY_MS - 1);
    expect(client.turns).toHaveLength(1);
    await wait(1);
    expect(client.turns).toHaveLength(2);

    // The turn sees what was applied: the reply's note, then the follow-up.
    const messages = client.last().request.messages;
    expect(messages.at(-2)?.text).toContain(proposalNote("applied"));
    expect(messages.at(-1)).toEqual({ role: "user", text: FOLLOW_UP_MESSAGE });
    expect(client.last().request.context.swing).toBe(58);

    // Tagged as the assistant's own, once.
    expect(sent()).toEqual([false, true]);
    expect(
      transport.events.filter(
        (event) =>
          event.name === "feature_first_use" &&
          event.params?.feature === "assistant_follow_up",
      ),
    ).toHaveLength(1);

    // An ordinary turn: it streams, and its reply shows; its message does not.
    client.last().text("Nice swing. Next, a bassline?");
    client.last().done();
    flush();
    const entries = chat.conversation.entries();
    expect(entries.at(-2)).toMatchObject({ kind: "message", automatic: true });
    expect(entries.at(-1)).toMatchObject({
      kind: "reply",
      text: "Nice swing. Next, a bassline?",
    });

    // And nothing more comes of it.
    await wait(FOLLOW_UP_DELAY_MS * 5);
    expect(client.turns).toHaveLength(2);
  });

  it("takes no turn when the proposal is dismissed", async () => {
    const { chat, client, propose, wait, sent } = await setUp();
    const card = await propose();
    // The first Cancel ends the preview that opened by itself (GRV-193).
    chat.proposals?.cancel(card);
    flush();
    chat.proposals?.cancel(card);
    flush();
    expect(chat.proposals?.card(card)?.status).toBe("cancelled");
    await wait(FOLLOW_UP_DELAY_MS * 5);
    expect(client.turns).toHaveLength(1);
    expect(sent()).toEqual([false]);
  });

  it("takes one turn for a run of applies from one turn", async () => {
    const { chat, client, propose, wait, sent, volume, session } = await setUp();
    expect(chat.conversation.send("Shape the beat")).toBe(true);
    await settle();
    // Three parts stream, and each is applied as it lands.
    const calls = [SWING, volume(-3), volume(-6)];
    for (const [index, call] of calls.entries()) {
      client.last().emit({
        type: "part",
        part: { index, toolsetVersion: ASSISTANT_TOOLSET_VERSION, call },
      });
      flush();
      chat.proposals?.applyPart(chat.conversation.entries().at(-1)?.id ?? "", index);
      flush();
      await wait(FOLLOW_UP_DELAY_MS / 2);
    }
    // Still writing: the follow-up waits for the turn to end.
    await wait(FOLLOW_UP_DELAY_MS * 2);
    expect(client.turns).toHaveLength(1);
    client.last().done();
    flush();
    await settle();
    flush();
    expect(client.turns).toHaveLength(2);
    expect(sent()).toEqual([false, true]);
    expect(session.committedProject.song.swing).toBe(58);

    // Two whole proposals applied one after the other are one run too.
    client.last().done();
    flush();
    const first = await propose([SWING]);
    chat.proposals?.apply(first);
    flush();
    await wait(FOLLOW_UP_DELAY_MS / 2);
    expect(client.turns).toHaveLength(3);
  });

  it("drops the follow-up when the producer speaks first, or undoes the change", async () => {
    const spoken = await setUp();
    spoken.chat.proposals?.apply(await spoken.propose());
    flush();
    expect(spoken.chat.conversation.send("Now a bassline")).toBe(true);
    await settle();
    spoken.client.last().done();
    flush();
    await spoken.wait(FOLLOW_UP_DELAY_MS * 5);
    expect(spoken.client.turns).toHaveLength(2);
    expect(spoken.sent()).toEqual([false, false]);

    const undone = await setUp();
    const card = await undone.propose();
    undone.chat.proposals?.apply(card);
    flush();
    undone.chat.proposals?.undo(card);
    await settle();
    flush();
    expect(undone.chat.proposals?.card(card)?.status).toBe("undone");
    await undone.wait(FOLLOW_UP_DELAY_MS * 5);
    expect(undone.client.turns).toHaveLength(1);
  });

  it("drops the follow-up when the one part applied is undone, and a redo brings none", async () => {
    const { chat, client, wait, sent, volume, session } = await setUp();
    expect(chat.conversation.send("Shape the beat")).toBe(true);
    await settle();
    const calls = [SWING, volume(-3), volume(-6)];
    for (const [index, call] of calls.entries()) {
      client.last().emit({
        type: "part",
        part: { index, toolsetVersion: ASSISTANT_TOOLSET_VERSION, call },
      });
    }
    client.last().done();
    flush();
    const card = chat.conversation
      .entries()
      .findLast((entry) => entry.kind === "proposal");
    if (!card) throw new Error("no streamed card");
    // Two parts go in, and their follow-up starts.
    chat.proposals?.applyPart(card.id, 0);
    flush();
    chat.proposals?.applyPart(card.id, 1);
    flush();
    await wait();
    expect(client.turns).toHaveLength(2);

    // While it still streams, one more part goes in and straight out again.
    chat.proposals?.applyPart(card.id, 2);
    flush();
    chat.proposals?.undo(card.id);
    await settle();
    flush();
    await wait();
    client.last().done();
    flush();
    await wait(FOLLOW_UP_DELAY_MS * 5);
    expect(client.turns).toHaveLength(2);

    // A redo is not an Apply.
    expect(session.redo()?.ok).toBe(true);
    flush();
    await wait(FOLLOW_UP_DELAY_MS * 5);
    expect(client.turns).toHaveLength(2);
    expect(sent()).toEqual([false, true]);
  });

  it("shows the normal error when the follow-up fails, and the change stays", async () => {
    const { chat, client, propose, wait, session } = await setUp();
    const card = await propose();
    chat.proposals?.apply(card);
    flush();
    await wait();
    expect(client.turns).toHaveLength(2);
    client.last().fail({ code: "provider_unavailable", retryable: true });
    flush();

    const last = chat.conversation.entries().at(-1);
    expect(last).toMatchObject({
      kind: "error",
      error: { code: "provider_unavailable" },
    });
    expect(last && chat.conversation.canRetry(last)).toBe(true);
    expect(session.committedProject.song.swing).toBe(58);
    expect(chat.proposals?.card(card)?.status).toBe("applied");

    // Try again resends the follow-up, still the assistant's own.
    expect(chat.conversation.retry()).toBe(true);
    await settle();
    expect(client.last().request.messages.at(-1)?.text).toBe(FOLLOW_UP_MESSAGE);
  });
});
