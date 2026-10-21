import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { REMEMBER_TOOL_NAME } from "../../assistant/memory";
import { EXPLAIN_TOOL_NAME } from "../../assistant/tools";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { useProducerProfile } from "../../memory/useProducerProfile";
import { InMemoryProfileRepository } from "../../persistence/inMemoryProfileRepository";
import { emptyProfile } from "../../persistence/profileDocuments";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import type { EditorViewName } from "../composition/editorViews";
import AssistantPanel from "./AssistantPanel";
import { MEMORY_CARD_LABEL } from "./MemoryProposalCard";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";

afterEach(cleanup);

const UID = "user-1";

async function renderChat() {
  const client = createFakeAssistantClient();
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const profiles = new InMemoryProfileRepository();
  await profiles.saveProfile(UID, {
    ...emptyProfile(1),
    onboarding: "completed",
    memory: { ...emptyProfile(1).memory, taste: ["Techno"] },
    laterQuestions: ["goal"],
  });
  const project = createSliceFixtureProject();
  const [view] = createSignal<EditorViewName>("arrangement");
  const Harness = () => {
    const panel = useAssistantPanel({
      storage: memoryStorage(),
      analytics: () => analytics,
    });
    const profile = useProducerProfile({
      uid: () => UID,
      repository: async () => profiles,
    });
    const chat = useAssistantChat({
      project: () => project,
      view,
      sources: () => ({ selection: null, track: project.song.tracks[0] ?? null }),
      account: () => ({ registered: true }),
      expanded: () => true,
      client: async () => client,
      analytics: () => analytics,
      profile,
    });
    return (
      <>
        <button type="button" onClick={(event) => panel.toggle(event.currentTarget)}>
          Open it
        </button>
        <AssistantPanel panel={panel} chat={chat} />
      </>
    );
  };
  render(() => <Harness />);
  clickAndFlush(screen.getByRole("button", { name: "Open it" }));
  return { client, transport, profiles };
}

const panel = () => screen.getByRole("region", { name: "Coproducer" });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function send(text: string) {
  const composer = within(panel()).getByRole("textbox", { name: "Message Coproducer" });
  fireAndFlush(() => fireEvent.input(composer, { target: { value: text } }));
  clickAndFlush(within(panel()).getByRole("button", { name: "Send" }));
  await settle();
}

/**
 * Coproducer's reply proposing a note, as the gateway returns it among the calls,
 * with any other calls the reply made beside it.
 */
function proposeNote(
  client: ReturnType<typeof createFakeAssistantClient>,
  beside: readonly { id: string; name: string; input: unknown }[] = [],
) {
  const turn = client.last();
  fireAndFlush(() => turn.text("Shall I remember that?"));
  fireAndFlush(() =>
    turn.emit({
      type: "proposal",
      proposal: {
        baseRevision: 0,
        toolsetVersion: 7,
        calls: [
          {
            id: "toolu_1",
            name: REMEMBER_TOOL_NAME,
            input: { kind: "note", text: "Making more trap lately" },
          },
          ...beside,
        ],
      },
    }),
  );
  fireAndFlush(() => turn.done());
}

describe("Coproducer's memory in the conversation (GRV-25)", () => {
  it("sends what Coproducer remembers with every turn", async () => {
    const { client } = await renderChat();
    await waitFor(() => expect(panel()).toBeInTheDocument());
    await settle();
    await send("Let's make a beat");
    expect(client.last().request.memory).toMatchObject({
      taste: ["Techno"],
      askLater: "goal",
    });
  });

  it("proposes a note, saves it only on Remember, and takes it back on Undo", async () => {
    const { client, transport, profiles } = await renderChat();
    await settle();
    await send("I'm making more trap now");
    proposeNote(client);

    const card = screen.getByRole("region", { name: MEMORY_CARD_LABEL });
    expect(card).toHaveTextContent('"Making more trap lately"');
    let stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes).toEqual([]);
    expect(transport.named("memory_note_proposed")).toHaveLength(1);

    clickAndFlush(within(card).getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(card).toHaveTextContent("Saved to memory"));
    stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes.map((note) => note.text)).toEqual([
      "Making more trap lately",
    ]);
    expect(transport.named("memory_note_confirmed")).toHaveLength(1);
    expect(transport.named("memory_note_confirmed")[0]?.params).toMatchObject({
      kind: "note",
    });

    clickAndFlush(within(card).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(card).toHaveTextContent("Undone"));
    stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes).toEqual([]);
    expect(transport.named("memory_note_undone")).toHaveLength(1);
    expect(JSON.stringify(transport.events)).not.toContain("trap");
  });

  it("draws only the memory card when the note comes with an explanation", async () => {
    const { client } = await renderChat();
    await settle();
    await send("I'm making more trap now");
    proposeNote(client, [
      {
        id: "toolu_2",
        name: EXPLAIN_TOOL_NAME,
        input: { goal: "Remember what you make now", technique: "A note in memory" },
      },
    ]);
    expect(screen.getByRole("region", { name: MEMORY_CARD_LABEL })).toBeInTheDocument();
    // An explanation on its own changes nothing, so it is no proposal.
    expect(screen.queryByRole("region", { name: /^Proposal/ })).toBeNull();
    expect(within(panel()).queryByRole("alert")).toBeNull();
  });

  it("saves nothing when the producer says Not now", async () => {
    const { client, transport, profiles } = await renderChat();
    await settle();
    await send("I'm making more trap now");
    proposeNote(client);
    const card = screen.getByRole("region", { name: MEMORY_CARD_LABEL });
    clickAndFlush(within(card).getByRole("button", { name: "Not now" }));
    expect(card).toHaveTextContent("Not remembered.");
    const stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes).toEqual([]);
    expect(transport.named("memory_note_confirmed")).toHaveLength(0);
  });

  it("asks a question skipped in onboarding only once", async () => {
    const { client, profiles } = await renderChat();
    await settle();
    await send("What should I make?");
    const turn = client.last();
    fireAndFlush(() =>
      turn.emit({
        type: "ask",
        ask: {
          id: "toolu_9",
          question: "Do you have a goal?",
          options: [{ label: "A track" }, { label: "Curious" }],
          multiSelect: false,
          memoryQuestion: "goal",
        },
      }),
    );
    fireAndFlush(() => turn.done());
    await waitFor(async () => {
      const stored = await profiles.loadProfile(UID);
      expect(stored.ok && stored.profile?.laterQuestions).toEqual([]);
    });
  });
});
