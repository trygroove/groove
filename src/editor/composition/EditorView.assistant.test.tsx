import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analytics as defaultAnalytics } from "../../analytics";
import { createRecordingTransport } from "../../analytics/transport";
import { INITIAL_PIXELS_PER_TICK, ROW_METRICS } from "../../arrangement/ArrangementView";
import { RECOMMEND_SOUNDS_TOOL } from "../../assistant/recommendation";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { LibraryClient } from "../../library/libraryClient";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { detectPlatform } from "../../shortcuts";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  createFakeAssistantClient,
  type FakeAssistantClient,
} from "../../testing/fakeAssistantClient";
import { createFakeRetentionClient } from "../../testing/fakeRetentionClient";
import { LAYOUT_STORAGE_KEY } from "../assistant/assistantPanelLayout";
import {
  createStepGridProject,
  goToView,
  loadEditorView,
  openSequenceEditor,
  recordingAnalytics,
  renderEditor,
} from "./EditorView.testHarness";
import { createStarterProject } from "./starterProject";

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("../../audio/AudioRuntime");
let inMemoryModule: typeof import("../../persistence/inMemoryProjectRepository");
let _documentsModule: typeof import("../../persistence/documents");

beforeAll(async () => {
  AudioRuntimeModule = await import("../../audio/AudioRuntime");
  inMemoryModule = await import("../../persistence/inMemoryProjectRepository");
  _documentsModule = await import("../../persistence/documents");
  await loadEditorView();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The assistant's conversation is kept per tab (GRV-42): never across tests.
  sessionStorage.clear();
  try {
    await AudioRuntimeModule.getAudioRuntime().close();
  } catch {
    // already closed
  }
  AudioRuntimeModule.__resetAudioRuntimeForTests();
});

let repository: InMemoryProjectRepository;

vi.mock("../../projectRepositoryClient", () => ({
  getProjectRepository: () => Promise.resolve(repository),
}));

/** The assistant panel's place in the editor (#849, AI-004a). */
describe("EditorView assistant panel", () => {
  afterEach(() => localStorage.removeItem(LAYOUT_STORAGE_KEY));

  async function renderSlice(transport = createRecordingTransport()) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, { analytics: recordingAnalytics(transport) });
    await screen.findByTestId("arrangement-view-ready");
    return transport;
  }

  const panel = () => screen.queryByRole("region", { name: "Coproducer" });
  const panelButton = (name: string) =>
    within(screen.getByRole("region", { name: "Coproducer" })).getByRole("button", {
      name,
    });
  const launcher = () => screen.getByRole("button", { name: /^Coproducer$/ });
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireAndFlush(() =>
      fireEvent.keyDown(document.activeElement ?? window, { key, ...init }),
    );
  const assistantChord = () =>
    detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
  const dockSpace = () =>
    (document.querySelector("main.editor") as HTMLElement).style.getPropertyValue(
      "--assistant-dock-space",
    );

  it("opens and closes with Cmd/Ctrl+K, logged as the shortcut it is", async () => {
    // The controller logs `shortcut_used` through the app-wide instance.
    const log = vi.spyOn(defaultAnalytics, "log");
    const transport = await renderSlice();
    expect(panel()).toBeNull();
    expect(launcher()).toHaveAttribute("aria-pressed", "false");
    expect(launcher()).toHaveAttribute("aria-keyshortcuts");

    press("k", assistantChord());
    expect(panel()).toHaveAttribute("data-mode", "floating");
    expect(panel()).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-pressed", "true");

    press("k", assistantChord());
    expect(panel()).toBeNull();
    const uses = log.mock.calls.filter(
      ([name, params]) =>
        name === "shortcut_used" &&
        (params as { action_id?: string }).action_id === "assistant.toggle",
    );
    expect(uses).toHaveLength(2);
    expect(
      transport.named("feature_first_use").map((event) => event.params?.feature),
    ).toContain("assistant");
  });

  it("talks to the assistant from the composer: Enter sends, Shift+Enter adds a line (GRV-26)", async () => {
    const log = vi.spyOn(defaultAnalytics, "log");
    const client = createFakeAssistantClient();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(createRecordingTransport()),
      account: { uid: "u1", registered: true },
      assistantClient: async () => client,
    });
    await screen.findByTestId("arrangement-view-ready");

    await openPanel();
    const composer = within(panel() as HTMLElement).getByRole("textbox", {
      name: "Message Coproducer",
    });
    expect(composer).toHaveFocus();
    expect(panelButton("Scope: BD")).toBeInTheDocument();

    fireAndFlush(() => fireEvent.input(composer, { target: { value: "Loosen it" } }));
    press("Enter", { shiftKey: true });
    expect(client.turns).toHaveLength(0);
    press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.turns).toHaveLength(1);
    expect(client.last().request.messages.at(-1)?.text).toBe("Loosen it");
    expect(composer).toHaveValue("");
    expect(
      log.mock.calls.some(
        ([name, params]) =>
          name === "shortcut_used" &&
          (params as { action_id?: string }).action_id === "assistant.send",
      ),
    ).toBe(true);

    // While the reply streams, Escape in the composer still minimises the
    // panel, and the bar says the assistant is writing.
    fireAndFlush(() => client.last().text("Here"));
    press("Escape");
    expect(panel()).toHaveAttribute("data-mode", "minimised");
    expect(within(panel() as HTMLElement).getByText("Writing…")).toBeInTheDocument();
  });

  /**
   * Opens the assistant with its shortcut, and lets the account's answer to
   * the disclosure load: it is only asked for once the panel opens (GRV-8).
   */
  async function openPanel() {
    press("k", assistantChord());
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }

  /** The editor over `project`, signed in, talking to a fake assistant. */
  async function renderTalking(project: Project) {
    const client = createFakeAssistantClient();
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(transport),
      account: { uid: "u1", registered: true },
      assistantClient: async () => client,
    });
    await screen.findByTestId("arrangement-view-ready");
    return { client, transport };
  }

  /** Opens the panel over what is selected, and sends `text` from it. */
  async function openAndSend(client: FakeAssistantClient, text: string) {
    if (!panel()) await openPanel();
    const composer = within(panel() as HTMLElement).getByRole("textbox", {
      name: "Message Coproducer",
    });
    composer.focus();
    fireAndFlush(() => fireEvent.input(composer, { target: { value: text } }));
    press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return client.last().request;
  }

  const scopeChip = () =>
    within(screen.getByRole("region", { name: "Coproducer" })).getByRole("button", {
      name: /^Scope:/,
    });

  /** Ends the latest turn in a question with three options (GRV-42). */
  function askLatest(client: FakeAssistantClient, multiSelect = false) {
    fireAndFlush(() => {
      const turn = client.last();
      turn.text("One question first.");
      turn.emit({
        type: "ask",
        ask: {
          id: `toolu_${client.turns.length}`,
          question: "Where should the drop land?",
          options: [{ label: "Bar 17" }, { label: "Bar 25" }, { label: "Hold it back" }],
          multiSelect,
        },
      });
      turn.emit({
        type: "done",
        stopped: false,
        stopReason: "tool_use",
        requestsRemaining: 98,
      });
    });
  }
  const askCard = () =>
    within(panel() as HTMLElement).queryByRole("region", { name: "Coproducer asks" });
  const settleTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
  const currentView = () =>
    screen
      .getByRole("navigation", { name: "Views" })
      .querySelector("[aria-current='page']");

  it("answers a question with 1-8 while focus is in the panel, in place of the view keys (GRV-42)", async () => {
    const log = vi.spyOn(defaultAnalytics, "log");
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Build me a drop");
    askLatest(client);
    // The question took focus from the empty composer.
    expect(askCard()).toHaveFocus();

    press("2");
    await settleTurn();
    expect(askCard()).toBeNull();
    expect(client.turns).toHaveLength(2);
    expect(client.last().request.messages.at(-1)?.text).toBe(
      '[Answer to "Where should the drop land?"] Picked: Bar 25.',
    );
    // `2` picked; it did not also switch to the sequence view.
    expect(currentView()).toHaveAccessibleName("Arrangement");
    expect(
      log.mock.calls.some(
        ([name, params]) =>
          name === "shortcut_used" &&
          (params as { action_id?: string }).action_id === "assistant.ask_option_2",
      ),
    ).toBe(true);
  });

  it("toggles a multi-select with the number keys and sends it with Enter (GRV-42)", async () => {
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Which parts?");
    askLatest(client, true);

    press("1");
    press("3");
    // A number past the options does nothing.
    press("8");
    const card = within(askCard() as HTMLElement);
    expect(card.getByRole("button", { name: "Bar 17" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(card.getByRole("button", { name: "Hold it back" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(client.turns).toHaveLength(1);

    // Enter on a focused chip sends the picks rather than toggling it.
    card.getByRole("button", { name: "Bar 25" }).focus();
    press("Enter");
    await settleTurn();
    expect(client.last().request.messages.at(-1)?.text).toBe(
      '[Answer to "Where should the drop land?"] Picked: Bar 17, Hold it back.',
    );
  });

  it("keeps the digits for typing, and sends the question's own text box on Enter (GRV-42)", async () => {
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Build me a drop");
    askLatest(client);

    // In the composer a digit is typing, not an answer.
    const composer = within(panel() as HTMLElement).getByRole("textbox", {
      name: "Message Coproducer",
    });
    composer.focus();
    press("1");
    expect(askCard()).toBeInTheDocument();

    const other = within(askCard() as HTMLElement).getByRole("textbox", {
      name: "Something else",
    });
    other.focus();
    press("2");
    expect(askCard()).toBeInTheDocument();
    fireAndFlush(() => fireEvent.input(other, { target: { value: "Bar 21" } }));
    press("Enter");
    await settleTurn();
    expect(askCard()).toBeNull();
    expect(client.last().request.messages.at(-1)?.text).toBe(
      '[Answer to "Where should the drop land?"] Bar 21',
    );
  });

  it("selects what a picked option is about: a clip, in the arrangement (GRV-42)", async () => {
    const project = createSliceFixtureProject();
    const placement = project.song.placements[0];
    if (!placement) throw new Error("the slice fixture needs a placement");
    const { client } = await renderTalking(project);
    await openAndSend(client, "Which part?");
    fireAndFlush(() => {
      const turn = client.last();
      turn.emit({
        type: "ask",
        ask: {
          id: "toolu_ref",
          question: "Which part?",
          options: [
            { label: "That clip", ref: { kind: "clip", clipId: placement.clipId } },
            { label: "Something else" },
          ],
          multiSelect: false,
        },
      });
      turn.emit({
        type: "done",
        stopped: false,
        stopReason: "tool_use",
        requestsRemaining: 9,
      });
    });
    const chip = within(askCard() as HTMLElement).getByRole("button", {
      name: "That clip",
    });
    expect(chip).toHaveTextContent(/Clip /);

    press("1");
    await waitFor(() =>
      expect(screen.getByTestId("arrangement-selection-live")).toHaveTextContent(
        "Selected clip on BD, bar 1",
      ),
    );
    expect(askCard()).toBeNull();
  });

  it("previews an option's sound on Space, and puts it away when focus leaves (GRV-42)", async () => {
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Slower?");
    fireAndFlush(() => {
      const turn = client.last();
      turn.emit({
        type: "ask",
        ask: {
          id: "toolu_hear",
          question: "How slow?",
          options: [
            {
              label: "100 BPM",
              sound: {
                kind: "preview",
                calls: [
                  {
                    name: "parameter_set",
                    input: {
                      target: { scope: "song", parameterId: "song.tempo" },
                      value: 100,
                    },
                  },
                ],
              },
            },
            { label: "Leave it" },
          ],
          multiSelect: false,
        },
      });
      turn.emit({
        type: "done",
        stopped: false,
        stopReason: "tool_use",
        requestsRemaining: 9,
      });
    });
    const tempo = () => screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    expect(tempo()).toHaveValue(120);
    const chip = within(askCard() as HTMLElement).getByRole("button", {
      name: "100 BPM",
    });
    fireAndFlush(() => chip.focus());
    press(" ");
    // The song shows the preview; nothing was answered or applied.
    await waitFor(() => expect(tempo()).toHaveValue(100));
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);

    fireAndFlush(() => chip.blur());
    await waitFor(() => expect(tempo()).toHaveValue(120));
  });

  it("leaves Enter on a single choice's focused chip to the chip, even with text typed (GRV-42)", async () => {
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Build me a drop");
    askLatest(client);
    const card = within(askCard() as HTMLElement);
    const other = card.getByRole("textbox", { name: "Something else" });
    fireAndFlush(() => fireEvent.input(other, { target: { value: "after the fill" } }));

    const chip = card.getByRole("button", { name: "Bar 25" });
    chip.focus();
    let notPrevented = true;
    fireAndFlush(() => {
      notPrevented = fireEvent.keyDown(chip, { key: "Enter", bubbles: true });
    });
    await settleTurn();
    // The registry stood down: the text alone was not sent, and the browser's
    // Enter is left to press the chip.
    expect(notPrevented).toBe(true);
    expect(client.turns).toHaveLength(1);
    clickAndFlush(chip);
    await settleTurn();
    expect(client.last().request.messages.at(-1)?.text).toBe(
      '[Answer to "Where should the drop land?"] Picked: Bar 25. Also: after the fill',
    );
  });

  it("leaves 1-8 to the views while focus is outside the panel (GRV-42)", async () => {
    const { client } = await renderTalking(createSliceFixtureProject());
    await openAndSend(client, "Build me a drop");
    askLatest(client);
    (document.activeElement as HTMLElement | null)?.blur();

    press("2");
    await vi.waitFor(() => expect(currentView()).toHaveAccessibleName("Sequence"));
    expect(askCard()).toBeInTheDocument();
    expect(client.turns).toHaveLength(1);
  });

  /** A click on BD's row (the first) at bar 1 of the arrangement. */
  async function clickBdClip(): Promise<void> {
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 0.5 * 768 * INITIAL_PIXELS_PER_TICK,
        clientY: 22 + ROW_METRICS.trackHeightPx / 2,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireAndFlush(() => fireEvent(canvas, event));
    }
    await waitFor(() =>
      expect(screen.getByTestId("arrangement-selection-live")).toHaveTextContent(
        "Selected clip on BD, bar 1",
      ),
    );
  }

  it("keeps a Try pressed from the Library: leaving it does not clear the override (GRV-23)", async () => {
    const { ProjectAudioGraph } = await import("../../audio/ProjectAudioGraph");
    const reconcile = vi.spyOn(ProjectAudioGraph.prototype, "reconcile");
    const client = createFakeAssistantClient();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStarterProject("u1", () => 0.5);
    const [drums] = project.song.tracks;
    if (drums?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const bd = drums.instrument.pads.find((pad) => pad.name === "BD");
    if (!bd) throw new Error("no BD pad");
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      account: { uid: "u1", registered: true },
      assistantClient: async () => client,
      libraryClient: new LibraryClient(fixtureFetcher()),
      createAuditionEngine: fakePreviewEngine,
    });
    await screen.findByTestId("arrangement-view-ready");
    /** The asset BD plays in the graph's latest projection. */
    const heardOnBd = () => {
      const projection = reconcile.mock.lastCall?.[0];
      const instrument = projection?.tracksById.get(drums.id)?.instrument;
      if (instrument?.kind !== "drumMachine") return undefined;
      return instrument.pads.find((entry) => entry.id === bd.id)?.assetId;
    };

    await openAndSend(client, "Softer kicks?");
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: project.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [
            {
              id: "toolu_1",
              name: RECOMMEND_SOUNDS_TOOL,
              input: {
                packId: "pak_SdlN_OazweXrwury0j27Y",
                soundIds: ["sg-one-shot-drums-kick-0004"],
                reason: "Softer.",
                trackId: drums.id,
                padId: bd.id,
              },
            },
          ],
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    const card = await screen.findByRole("region", { name: /^Recommended pack/ });

    clickAndFlush(within(card).getByRole("button", { name: "Open in library" }));
    await screen.findByRole("region", { name: "Library" });
    clickAndFlush(within(card).getByRole("button", { name: "Try on BD" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: "Library" })).toBeNull(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(heardOnBd()).toMatch(/^ast_preview/);
    expect(within(card).getByRole("status")).toHaveTextContent("BD is trying");
  });

  it("makes a try stale when the pad's level changes under it (GRV-23)", async () => {
    const client = createFakeAssistantClient();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStarterProject("u1", () => 0.5);
    const [drums] = project.song.tracks;
    if (drums?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const bd = drums.instrument.pads.find((pad) => pad.name === "BD");
    if (!bd) throw new Error("no BD pad");
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      account: { uid: "u1", registered: true },
      assistantClient: async () => client,
      libraryClient: new LibraryClient(fixtureFetcher()),
      createAuditionEngine: fakePreviewEngine,
    });
    await screen.findByTestId("arrangement-view-ready");

    await openAndSend(client, "the kick is too clean, anything dustier?");
    fireAndFlush(() =>
      client.last().emit({
        type: "proposal",
        proposal: {
          baseRevision: project.metadata.revision,
          toolsetVersion: ASSISTANT_TOOLSET_VERSION,
          calls: [
            {
              id: "toolu_1",
              name: RECOMMEND_SOUNDS_TOOL,
              input: {
                packId: "pak_SdlN_OazweXrwury0j27Y",
                soundIds: ["sg-one-shot-drums-kick-0004"],
                reason: "Dustier.",
                trackId: drums.id,
                padId: bd.id,
              },
            },
          ],
        },
      }),
    );
    fireAndFlush(() => client.last().done());
    const card = await screen.findByRole("region", { name: /^Recommended pack/ });
    clickAndFlush(within(card).getByRole("button", { name: "Try on BD" }));
    expect(within(card).getByRole("status")).toHaveTextContent("BD is trying");

    const level = await screen.findByRole("slider", { name: "Level for BD" });
    // An arrow-key nudge: jsdom's range input does not move on a key, so the
    // events the browser fires for one are fired here.
    fireAndFlush(() => {
      level.focus();
      fireEvent.input(level, { target: { value: "-1" } });
      fireEvent.change(level, { target: { value: "-1" } });
    });

    await waitFor(() =>
      expect(within(card).getByRole("status")).toHaveTextContent(
        "Out of date. BD changed while a sound was being tried",
      ),
    );
    expect(within(card).queryByRole("button", { name: "Keep" })).toBeNull();
  });

  it("scopes to the clips selected in the arrangement, as a section (GRV-26)", async () => {
    const { client, transport } = await renderTalking(createSliceFixtureProject());
    await clickBdClip();
    await openPanel();
    expect(scopeChip()).toHaveAccessibleName("Scope: 1 clip");
    const request = await openAndSend(client, "Vary this");
    expect(request.context.selection?.countByKind).toEqual({ placement: 1 });
    expect(transport.named("assistant_message_sent").at(-1)?.params).toMatchObject({
      scope: "section",
    });
  });

  it("falls back to the track on a view that does not show the selection (GRV-26)", async () => {
    const { client, transport } = await renderTalking(createSliceFixtureProject());
    await clickBdClip();
    await goToView("Mixer");
    await openPanel();
    expect(scopeChip()).toHaveAccessibleName("Scope: BD");
    const request = await openAndSend(client, "Mix it");
    expect(request.context.selection?.countByKind).toEqual({ track: 1 });
    expect(transport.named("assistant_message_sent").at(-1)?.params).toMatchObject({
      scope: "track",
    });
  });

  it("scopes to the notes selected in the piano roll (GRV-26)", async () => {
    const { client, transport } = await renderTalking(createPianoRollFixtureProject());
    const editor = await openSequenceEditor();
    within(editor).getByRole("region", { name: /Piano roll/ });
    fireAndFlush(() => fireEvent.keyDown(window, { key: "a", ctrlKey: true }));
    expect(within(editor).getByText("4 selected")).toBeInTheDocument();
    await openPanel();
    expect(scopeChip()).toHaveAccessibleName("Scope: 4 notes");
    const request = await openAndSend(client, "Humanise these");
    expect(request.context.selectedNotes?.noteCount).toBe(4);
    expect(request.context.selection?.countByKind).toEqual({ event: 4 });
    expect(transport.named("assistant_message_sent").at(-1)?.params).toMatchObject({
      scope: "clip",
    });
  });

  it("scopes to the notes selected in the step editor (GRV-26)", async () => {
    const project = createStepGridProject();
    const notes =
      project.clips[0]?.content.kind === "notes" ? project.clips[0].content.events : [];
    const { client } = await renderTalking(project);
    const editor = await openSequenceEditor();
    within(editor).getByRole("region", { name: "Step editor" });
    fireAndFlush(() => fireEvent.keyDown(window, { key: "a", ctrlKey: true }));
    await openPanel();
    expect(scopeChip()).toHaveAccessibleName(`Scope: ${notes.length} notes`);
    const request = await openAndSend(client, "Swing these");
    expect(notes.length).toBeGreaterThan(0);
    expect(request.context.selectedNotes?.noteCount).toBe(notes.length);
    expect(request.context.selection?.countByKind).toEqual({ event: notes.length });
  });

  it("sends the hits written into a newly added drum track's clip (GRV-122)", async () => {
    const { client } = await renderTalking(createStarterProject("u1", () => 0.5));
    const add = screen.getByRole("group", { name: "Add track to the arrangement" });
    clickAndFlush(within(add).getByRole("button", { name: "Add drum machine track" }));
    const editor = await openSequenceEditor(1);
    clickAndFlush(
      within(within(editor).getByRole("group", { name: "Rows" })).getByRole("button", {
        name: "HH",
      }),
    );
    const generate = within(screen.getByRole("region", { name: "Generate" }));
    clickAndFlush(generate.getByRole("button", { name: "Eighths" }));
    await openPanel();
    expect(scopeChip()).toHaveAccessibleName("Scope: Drum machine");

    const request = await openAndSend(client, "make the hi-hats busier");

    const drums = request.context.tracks.find((track) => track.name === "Drum machine");
    const hh = drums?.pads.find((pad) => pad.name === "HH");
    // Which pad the hits are on, by name, so "hi-hats" finds them.
    expect.soft(hh?.noteCount).toBe(8);
    // And the hits themselves, so a denser pattern can be built from them.
    const hats = request.context.selectedNotes?.clips
      .filter((clip) => clip.trackId === drums?.id)
      .flatMap((clip) => clip.events)
      .filter((event) => event.trigger.kind === "pad" && event.trigger.padId === hh?.id);
    expect.soft(hats).toHaveLength(8);
  });

  it("asks for the account's answer to the disclosure only once the assistant opens (GRV-8)", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      account: { uid: "u1", registered: true },
      assistantClient: async () => createFakeAssistantClient(),
      assistantRetentionClient: async () => retention,
    });
    await screen.findByTestId("arrangement-view-ready");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retention.requests).toEqual([]);

    await openPanel();
    expect(retention.requests).toEqual([{ op: "get" }]);
    expect(
      within(panel() as HTMLElement).getByRole("textbox", {
        name: "Message Coproducer",
      }),
    ).toBeInTheDocument();
  });

  it("offers a sign-in in place of the composer to someone not signed in (GRV-26)", async () => {
    await renderSlice();
    await openPanel();
    expect(panel()).toHaveFocus();
    expect(within(panel() as HTMLElement).queryByRole("textbox")).toBeNull();
    expect(panel()).toHaveTextContent("Sign in to talk to Coproducer.");
  });

  it("puts the Coproducer button first in the header's document zone: Coproducer, Export, Help", async () => {
    await renderSlice();
    const end = document.querySelector(".editor-header-end") as HTMLElement;
    const names = within(end)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    const order = ["Coproducer", "Export", "Keyboard shortcuts"].map((name) =>
      names.indexOf(name),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[1] - order[0]).toBe(1);
    expect(order[2] - order[1]).toBe(1);
  });

  it("opens from the header button, and gives the button focus back on close", async () => {
    await renderSlice();
    launcher().focus();
    clickAndFlush(launcher());
    expect(panel()).toHaveFocus();
    panelButton("Close").focus();
    clickAndFlush(panelButton("Close"));
    expect(panel()).toBeNull();
    expect(launcher()).toHaveFocus();
  });

  it("minimises a floating panel on Escape, and closes a docked one", async () => {
    await renderSlice();
    launcher().focus();
    await openPanel();
    press("Escape");
    expect(panel()).toHaveAttribute("data-mode", "minimised");

    clickAndFlush(panelButton("Dock to the right"));
    panelButton("Float").focus();
    press("Escape");
    expect(panel()).toBeNull();
    expect(launcher()).toHaveFocus();
    // Out of the panel, Escape is not the panel's.
    await openPanel();
    launcher().focus();
    press("Escape");
    expect(panel()).toHaveAttribute("data-mode", "docked");
  });

  it("steps the size from its focused edge, and the arrows mean nothing else there", async () => {
    // Two tracks in the instrument view, where ↑/↓ otherwise step the
    // selected track (#533): on the edge they must leave it where it is.
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    await goToView("Instrument");
    const drumRegion = `Drum machine: ${project.song.tracks[0].name}`;
    expect(screen.getByRole("region", { name: drumRegion })).toBeInTheDocument();

    await openPanel();
    const edge = within(panel() as HTMLElement).getByRole("separator");
    edge.focus();
    press("ArrowUp");
    expect(edge).toHaveAttribute("aria-valuenow", "576");
    press("ArrowDown", { shiftKey: true });
    expect(edge).toHaveAttribute("aria-valuenow", "512");
    press("ArrowDown");
    expect(edge).toHaveAttribute("aria-valuenow", "496");
    // The selected track is unchanged: the arrows were the edge's alone.
    expect(screen.getByRole("region", { name: drumRegion })).toBeInTheDocument();

    clickAndFlush(panelButton("Dock to the right"));
    const docked = within(panel() as HTMLElement).getByRole("separator");
    docked.focus();
    press("ArrowLeft", { shiftKey: true });
    expect(docked).toHaveAttribute("aria-valuenow", "448");
    press("ArrowRight");
    expect(docked).toHaveAttribute("aria-valuenow", "432");
  });

  it("leaves the docked column free in the editor's layout, and only while docked", async () => {
    await renderSlice();
    expect(dockSpace()).toBe("0px");
    await openPanel();
    expect(dockSpace()).toBe("0px");
    clickAndFlush(panelButton("Dock to the right"));
    expect(dockSpace()).toBe("384px");
    clickAndFlush(panelButton("Close"));
    expect(dockSpace()).toBe("0px");
  });

  it("drops under a modal dialog and out of reach until it closes", async () => {
    await renderSlice();
    await openPanel();
    expect(panel()).not.toHaveAttribute("inert");

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    await screen.findByRole("dialog", { name: "Export" });
    const region = document.querySelector(".assistant-panel") as HTMLElement;
    expect(region).toHaveAttribute("inert");
    expect(region).toHaveClass("assistant-panel-under-modal");
    // Cmd/Ctrl+K is the editor's, which the dialog stands down.
    await openPanel();
    expect(region).toHaveAttribute("data-mode", "floating");

    clickAndFlush(screen.getByRole("button", { name: "Close export" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Export" })).not.toBeInTheDocument(),
    );
    expect(panel()).not.toHaveAttribute("inert");
    expect(panel()).not.toHaveClass("assistant-panel-under-modal");
  });

  it("lists Cmd/Ctrl+K in the shortcut guide", async () => {
    await renderSlice();
    press("?");
    const guide = await screen.findByRole("dialog", { name: /keyboard/i });
    expect(within(guide).getByText("Open or close Coproducer")).toBeInTheDocument();
  });
});
