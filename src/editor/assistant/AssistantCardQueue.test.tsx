import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantToolCall } from "../../assistant/protocol";
import { RECOMMEND_SOUNDS_TOOL } from "../../assistant/recommendation";
import { ASSISTANT_TOOLSET_VERSION, CREATE_EXAMPLES } from "../../assistant/tools";
import type { ControlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import type { Project, Track } from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { loadPadSampleCommands, toLibrarySample } from "../../library/insertion";
import { LibraryClient } from "../../library/libraryClient";
import type { LibraryAsset } from "../../library/manifest";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  createFakeAssistantClient,
  type FakeAssistantClient,
} from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import { assistantProposalTarget } from "../assistantProposalTarget";
import { EditorSession } from "../EditorSession";
import type { EditorLocation } from "../editorControls";
import type { EditorViewName } from "../editorViews";
import { emptyPadSelection } from "../padSelection";
import { createStarterProject } from "../starterProject";
import AssistantPanel from "./AssistantPanel";
import { createAssistantLibrary } from "./assistantLibrary";
import {
  type ConversationStore,
  conversationStorageKey,
  createConversationStore,
} from "./conversationStore";
import { MISSING_PAD } from "./RecommendationCard";
import { recommendationSlot } from "./recommendationCardModel";
import { useAssistantChat } from "./useAssistantChat";
import { useAssistantPanel } from "./useAssistantPanel";
import type { RecommendationEditorPort } from "./useAssistantRecommendations";

/**
 * GRV-129: a turn that proposes a new drum machine and recommends a sound for
 * each of its pads, as the first-beat lesson's does. The panel shows one card
 * at a time, and each recommendation finds its pad when it is shown, so the
 * kick, the snare and the hat each land on their own.
 */

afterEach(cleanup);

const ARRANGEMENT = { view: "arrangement" } as unknown as EditorLocation;
const DRUMS = "pak_SdlN_OazweXrwury0j27Y";
const KICKS = [
  "sg-one-shot-drums-kick-0004",
  "sg-one-shot-drums-kick-0002",
  "sg-one-shot-drums-kick-0003",
] as const;
const KIT_ID = "trk_FirstBeatSnareHat0001";
const SNARE_PAD = "pad_FirstBeatSnare0000001";
const HAT_PAD = "pad_FirstBeatHat000000001";

const emptyPad = (id: string, name: string) => ({
  id,
  name,
  assetId: null,
  chokeGroup: null,
  parameters: {},
  mixer: { volume: 0, pan: 0, muted: false, soloed: false },
});

async function setUp(
  options: {
    /** Where the conversation is kept across a reload (GRV-135). */
    readonly conversationStore?: ConversationStore;
    /** The song as the reload found it; the starter project by default. */
    readonly project?: Project;
  } = {},
) {
  const repository = createInMemoryProjectRepository();
  const project = options.project ?? createStarterProject("uid-1");
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("the starter project failed to create");
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
  const client: FakeAssistantClient = createFakeAssistantClient();
  const registry = createControlRegistry();
  const revealControl = vi.fn(
    (_address: ControlAddress, _options?: { focus?: boolean }) => ARRANGEMENT,
  );
  const restoreView = vi.fn((_location: EditorLocation) => {});
  const track = project.song.tracks[0];
  if (track?.instrument?.kind !== "drumMachine") throw new Error("no starter kit");
  const kickPad = track.instrument.pads[0];
  if (!kickPad) throw new Error("the starter has no pad");
  const library = createAssistantLibrary(new LibraryClient(fixtureFetcher()));

  const [shown, setShown] = createSignal<Project>(session.project);
  const [previewing, setPreviewing] = createSignal(false);
  session.subscribe((snapshot) => {
    setShown(snapshot.project);
    setPreviewing(snapshot.previewing);
  });
  // The starter's BD track stays selected throughout, as it would in the editor.
  const selected = (): Track | null => track;
  const [view] = createSignal<EditorViewName>("arrangement");
  const port = {
    slotFor: (trackId: string | null, padId: string | null) =>
      recommendationSlot(shown(), trackId, padId, selected(), emptyPadSelection),
    previewInSlot: vi.fn((_slot, _sound: LibraryAsset) => true),
    clearPreview: vi.fn(() => {}),
    keep: vi.fn(async (target, sound: LibraryAsset) => {
      const sample = toLibrarySample(sound);
      if (!sample || target.kind !== "pad") return { ok: false, reason: "No." } as const;
      const result = session.dispatch(
        loadPadSampleCommands(
          session.committedProject,
          target.trackId,
          target.padId,
          sample,
          createFactoryContext(),
        ),
      );
      return result?.ok
        ? ({ ok: true } as const)
        : ({ ok: false, reason: "No." } as const);
    }),
    openLibrary: vi.fn((_slug: string, _slot) => {}),
    createAuditionEngine: () => fakePreviewEngine(),
  } satisfies RecommendationEditorPort;

  const Harness = () => {
    const panel = useAssistantPanel({
      storage: memoryStorage(),
      analytics: () => analytics,
    });
    const chat = useAssistantChat({
      project: shown,
      view,
      sources: () => ({ selection: null, track }),
      account: () => ({ registered: true }),
      expanded: () => panel.layout().mode === "floating",
      client: async () => client,
      analytics: () => analytics,
      ...(options.conversationStore
        ? {
            conversationKey: () => conversationStorageKey("uid-1", project.metadata.id),
            conversationStore: options.conversationStore,
          }
        : {}),
      editor: {
        session: {
          proposalTarget: () => assistantProposalTarget(session),
          beginPreview: (commands) => session.beginPreview(commands),
          onEdit: (listener) => session.subscribeEdits(listener),
          onRemoteChange: (listener) => session.subscribeRemoteChanges(listener),
          previewing,
        },
        controls: { registry, revealControl, restoreView },
        recommendations: { library, port },
      },
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

  const recommend = (soundId: string, trackId: string, padId: string) => ({
    name: RECOMMEND_SOUNDS_TOOL,
    input: { packId: DRUMS, soundIds: [soundId], reason: "It fits.", trackId, padId },
  });

  /**
   * Asks for a first beat, and answers as the lesson's turn does: a proposal
   * that adds the "Snare & Hat" kit, and a kick, a snare and a hat for BD,
   * Snare and Hat.
   */
  async function firstBeat(): Promise<void> {
    fireAndFlush(() =>
      fireEvent.input(composer(), { target: { value: "Make my first beat" } }),
    );
    clickAndFlush(button("Send"));
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    const calls: AssistantToolCall[] = [
      {
        id: "toolu_1",
        name: "track_create",
        input: {
          ...CREATE_EXAMPLES.track,
          id: KIT_ID,
          name: "Snare & Hat",
          order: 1,
          instrument: {
            kind: "drumMachine",
            parameters: {},
            pads: [emptyPad(SNARE_PAD, "Snare"), emptyPad(HAT_PAD, "Hat")],
          },
        },
      },
      { id: "toolu_2", ...recommend(KICKS[0], track?.id ?? "", kickPad?.id ?? "") },
      { id: "toolu_3", ...recommend(KICKS[1], KIT_ID, SNARE_PAD) },
      { id: "toolu_4", ...recommend(KICKS[2], KIT_ID, HAT_PAD) },
    ];
    fireAndFlush(() => client.last().text("Let's build it."));
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: session.committedProject.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls,
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    // The library loads before the cards resolve their sounds.
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    await settle();
    flush();
  }

  const padAsset = (trackId: string, padId: string) => {
    const kit = session.committedProject.song.tracks.find(
      (entry) => entry.id === trackId,
    )?.instrument;
    return kit?.kind === "drumMachine"
      ? kit.pads.find((entry) => entry.id === padId)?.assetId
      : undefined;
  };
  const events = (name: string) =>
    transport.events.filter((event) => event.name === name);

  return { session, track, kickPad, firstBeat, padAsset, events };
}

const panel = () => screen.getByRole("region", { name: "Coproducer" });
const composer = () =>
  within(panel()).getByRole("textbox", { name: "Message Coproducer" });
const button = (name: string | RegExp) => within(panel()).getByRole("button", { name });
const proposals = () => within(panel()).queryAllByRole("region", { name: /^Proposal\b/ });
const cards = () =>
  within(panel()).queryAllByRole("region", { name: /^Recommended pack\b/ });
const newest = () => {
  const card = cards().at(-1);
  if (!card) throw new Error("no recommended pack on screen");
  return card;
};
const cardButton = (name: string | RegExp) =>
  within(newest()).getByRole("button", { name });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function press(element: HTMLElement): Promise<void> {
  element.focus();
  clickAndFlush(element);
  await settle();
  flush();
  await settle();
  flush();
}

async function tryAndKeep(pad: string): Promise<void> {
  const card = newest();
  await press(within(card).getByRole("button", { name: `Try on ${pad}` }));
  await press(within(card).getByRole("button", { name: "Keep" }));
  await vi.waitFor(() =>
    expect(within(card).getByRole("status")).toHaveTextContent(/Kept/),
  );
}

describe("a turn's cards, one at a time (GRV-129)", () => {
  it("shows only the proposal at first, with 3 more after it", async () => {
    const { firstBeat, events } = await setUp();
    await firstBeat();
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toHaveTextContent("3 more after this");
    expect(cards()).toHaveLength(0);
    // A card held back is not shown, so it is not counted as shown.
    expect(events("assistant_recommendation_shown")).toHaveLength(0);
  });

  it("after Apply, shows the cards one by one, each aimed at its own pad", async () => {
    const { firstBeat, track, kickPad, padAsset } = await setUp();
    await firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Apply" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(proposals()[0]).not.toHaveTextContent(/more after this/);

    // The kick: on BD's own pad.
    expect(newest()).toHaveTextContent("BD · BD");
    expect(cardButton("Try on BD")).toBeEnabled();
    expect(newest()).toHaveTextContent("2 more after this");
    await tryAndKeep("BD");
    const kick = padAsset(track.id, kickPad.id);

    // The snare: on the new kit's Snare pad, not on BD.
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(newest()).toHaveTextContent("Snare & Hat · Snare");
    expect(newest()).toHaveTextContent("1 more after this");
    await tryAndKeep("Snare");
    expect(padAsset(KIT_ID, SNARE_PAD)).not.toBeNull();
    // The kick stays on BD after the snare is kept.
    expect(padAsset(track.id, kickPad.id)).toBe(kick);

    // The hat: on Hat, and nothing more after it.
    await vi.waitFor(() => expect(cards()).toHaveLength(3));
    expect(newest()).toHaveTextContent("Snare & Hat · Hat");
    expect(newest()).not.toHaveTextContent(/more after this/);
    await tryAndKeep("Hat");
    expect(padAsset(KIT_ID, HAT_PAD)).not.toBeNull();
    expect(padAsset(KIT_ID, SNARE_PAD)).not.toBe(padAsset(KIT_ID, HAT_PAD));
  });

  it("after Decline, skips the cards for the declined track and says so", async () => {
    const { firstBeat } = await setUp();
    await firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Cancel" }),
    );
    // The kick's pad is in the song: its card is shown, and nothing follows it.
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(newest()).toHaveTextContent("BD · BD");
    expect(newest()).not.toHaveTextContent(/more after this/);
    expect(panel()).toHaveTextContent(
      "Skipped 2 sound suggestions for the declined track",
    );
  });

  it("disables Try on a shown card whose pad an undo took away, and brings it back on redo", async () => {
    const { firstBeat, session } = await setUp();
    await firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Apply" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await press(cardButton("Dismiss"));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(cardButton("Try on Snare")).toBeEnabled();

    // Undoing the proposal takes the Snare & Hat track, and its pads, away.
    fireAndFlush(() => session.undo());
    await settle();
    flush();
    expect(within(newest()).queryByRole("button", { name: "Try on Snare" })).toBeNull();
    expect(cardButton("Try")).toBeDisabled();
    expect(within(newest()).getByRole("status")).toHaveTextContent(MISSING_PAD);

    fireAndFlush(() => session.redo());
    await settle();
    flush();
    expect(cardButton("Try on Snare")).toBeEnabled();
    expect(within(newest()).getByRole("status")).not.toHaveTextContent(MISSING_PAD);
  });

  it("holds the later cards back again when a Keep is undone", async () => {
    const { firstBeat, session } = await setUp();
    await firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Apply" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await tryAndKeep("BD");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    await press(cardButton("Try on Snare"));
    expect(cardButton("Keep")).toBeEnabled();

    // The kick's keep is undone: its card is the one to decide again, so the
    // snare's waits behind it, its try put back, and the hat's with it.
    fireAndFlush(() => session.undo());
    await settle();
    flush();
    expect(cards()).toHaveLength(1);
    expect(newest()).toHaveTextContent("BD · BD");
    expect(within(newest()).getByRole("status")).toHaveTextContent(/Undone/);
    expect(newest()).toHaveTextContent("2 more after this");

    // Keeping the kick again brings the snare back, nothing tried on it.
    await tryAndKeep("BD");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(newest()).toHaveTextContent("Snare & Hat · Snare");
    expect(cardButton("Try on Snare")).toBeEnabled();
    expect(newest()).toHaveTextContent("1 more after this");
  });

  it("shows the next card once one is dismissed", async () => {
    const { firstBeat } = await setUp();
    await firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Apply" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await press(cardButton("Dismiss"));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(newest()).toHaveTextContent("Snare & Hat · Snare");
  });
});

describe("a turn's cards across a reload (GRV-135)", () => {
  it("brings back the sound card on screen and the one held behind it, not the decided ones", async () => {
    const store = createConversationStore(memoryStorage());
    const before = await setUp({ conversationStore: store });
    await before.firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Apply" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await tryAndKeep("BD");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(newest()).toHaveTextContent("1 more after this");
    const song = before.session.committedProject;
    cleanup();

    await setUp({ conversationStore: store, project: song });
    // The library loads again before the sound card resolves its sounds.
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    // The applied proposal and the kept kick were decided: they stay gone.
    expect(proposals()).toHaveLength(0);
    expect(newest()).toHaveTextContent("Snare & Hat · Snare");
    expect(newest()).toHaveTextContent("1 more after this");
    expect(cardButton("Try on Snare")).toBeEnabled();

    await press(cardButton("Dismiss"));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(newest()).toHaveTextContent("Snare & Hat · Hat");
  });

  it("does not bring back the cards skipped for a declined proposal", async () => {
    const store = createConversationStore(memoryStorage());
    const before = await setUp({ conversationStore: store });
    await before.firstBeat();
    await press(
      within(proposals()[0] as HTMLElement).getByRole("button", { name: "Cancel" }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const song = before.session.committedProject;
    cleanup();

    await setUp({ conversationStore: store, project: song });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(proposals()).toHaveLength(0);
    expect(newest()).toHaveTextContent("BD · BD");
    expect(newest()).not.toHaveTextContent(/more after this/);
    await settle();
    flush();
    expect(cards()).toHaveLength(1);
  });
});
