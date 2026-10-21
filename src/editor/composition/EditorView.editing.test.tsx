import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecordingTransport } from "../../analytics/transport";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import {
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { LibraryClient } from "../../library/libraryClient";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { NEW_TRACK_KINDS } from "../tracks/trackCreation";
import {
  backFromInsert,
  createStepGridProject,
  firePointerAtStarterClip,
  goToView,
  insertSound,
  leaveForArrangement,
  leaveLibrary,
  loadEditorView,
  loopAssetName,
  mixerSelect,
  oneShotAssetName,
  openLibrary,
  openSequenceEditor,
  recordingAnalytics,
  renderEditor,
} from "./EditorView.testHarness";

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

/**
 * The Library panel builds one audition engine per mount (LOOP-013). Toggling
 * the panel closed unmounts `LibraryBrowser`, whose `useLibraryBrowser` disposes
 * the engine; a `ToneAuditionEngine` stays disposed permanently, so a cached
 * single engine would be dead on the second open and every audition would then
 * fail with `asset_missing`. This asserts each open gets a fresh, live engine.
 */
describe("EditorView library audition engine lifecycle", () => {
  async function renderWithLibrary() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    const engines: ReturnType<typeof fakePreviewEngine>[] = [];
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => {
        const engine = fakePreviewEngine();
        engines.push(engine);
        return engine;
      },
    });
    return { engines };
  }

  it("builds a fresh, live engine on each open and disposes the closed one", async () => {
    const { engines } = await renderWithLibrary();

    // The library is closed until a slot opens it (UI-001), so no engine
    // exists until then.
    expect(engines).toHaveLength(0);
    await openLibrary();
    expect(engines).toHaveLength(1);
    expect(engines[0].disposed()).toBe(false);

    // Closing unmounts LibraryBrowser, which disposes that engine.
    await leaveLibrary();
    await waitFor(() => expect(engines[0].disposed()).toBe(true));

    // Reopening builds a second, distinct, undisposed engine — never the dead
    // first one. Under the old cached-singleton bug this would still be
    // engines[0], now disposed, and audition would fail for the rest of the
    // session.
    clickAndFlush(screen.getByRole("button", { name: "Sample" }));
    await screen.findByRole("region", { name: "Library" });
    expect(engines).toHaveLength(2);
    expect(engines[1]).not.toBe(engines[0]);
    expect(engines[1].disposed()).toBe(false);

    // The fresh engine still starts an audition — the exact path the bug broke.
    await expect(
      engines[1].start({ id: "ast_x", url: "sound.wav" } as never, {
        sync: false,
      }),
    ).resolves.toBeDefined();
  });
});

/** The Instrument view's own layout (`UI-001`, CF-008). */
describe("EditorView instrument view", () => {
  async function renderDrums() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await goToView("Instrument");
    return project;
  }

  const rail = () => screen.getByRole("list", { name: "Tracks" });

  it("lists every track down the rail and marks the one on screen", async () => {
    const project = await renderDrums();
    const [drums, breakTrack] = project.song.tracks;

    expect(within(rail()).getAllByRole("listitem")).toHaveLength(2);
    expect(rail()).toHaveTextContent(drums.name);
    expect(rail()).toHaveTextContent(breakTrack.name);
    expect(
      within(rail()).getByRole("button", { name: `Edit ${drums.name}` }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("switches tracks from the rail, which every other view follows", async () => {
    const project = await renderDrums();
    const [drums, breakTrack] = project.song.tracks;

    clickAndFlush(
      within(rail()).getByRole("button", { name: `Edit ${breakTrack.name}` }),
    );

    expect(screen.getByRole("region", { name: `${breakTrack.name} loop` })).toBeVisible();
    expect(
      screen.queryByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).not.toBeInTheDocument();
    // Selection is one piece of state (UI-001): the mixer marks it too.
    await goToView("Mixer");
    expect(mixerSelect(breakTrack.name)).toHaveAttribute("aria-pressed", "true");
  });

  it("shows only the instrument: the timeline is not on the page", async () => {
    await renderDrums();

    expect(screen.queryByTestId("arrangement-view-ready")).not.toBeInTheDocument();
    // ...and the device chain has a labelled home waiting for #241.
    expect(screen.getByRole("region", { name: "Device chain" })).toBeVisible();
  });
});

/** Adding a track, from either surface that offers it (`UI-001`, #223). */
describe("EditorView new-track unit", () => {
  async function renderSlice(transport: ReturnType<typeof createRecordingTransport>) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, { analytics: recordingAnalytics(transport) });
    await screen.findByTestId("arrangement-view-ready");
  }

  const trackRows = () =>
    within(screen.getByLabelText("Arrangement tracks")).getAllByRole("listitem");

  /** The `feature` of every `feature_first_use` the session has logged. */
  const firstUseKeys = (transport: ReturnType<typeof createRecordingTransport>) =>
    transport.named("feature_first_use").map((event) => event.params?.feature);

  it("offers every registered kind on the arrangement, and creates one", async () => {
    const transport = createRecordingTransport();
    await renderSlice(transport);
    const unit = screen.getByRole("group", { name: "Add track to the arrangement" });

    // From the shared kind table, not a list written into the view.
    for (const spec of NEW_TRACK_KINDS) {
      expect(within(unit).getByRole("button", { name: spec.actionLabel })).toBeVisible();
    }
    expect(trackRows()).toHaveLength(1);

    clickAndFlush(within(unit).getByRole("button", { name: "Add sampler track" }));

    await vi.waitFor(() => expect(trackRows()).toHaveLength(2));
    // One `track.add`, so one undo takes the whole track back.
    const undo = screen.getByRole("button", { name: /^Undo / });
    clickAndFlush(undo);
    await vi.waitFor(() => expect(trackRows()).toHaveLength(1));
    const added = transport.events.filter((event) => event.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toEqual(
      expect.objectContaining({ track_type: "instrument", instrument_type: "sampler" }),
    );
    expect(firstUseKeys(transport)).toEqual(["arrangement"]);
  });

  it("adds a track from the instrument view's rail and shows it there (#495)", async () => {
    const transport = createRecordingTransport();
    await renderSlice(transport);
    await goToView("Instrument");
    const rail = screen.getByRole("list", { name: "Tracks" });
    const rows = () => within(rail).getAllByRole("button", { name: /^Edit / });
    expect(rows()).toHaveLength(1);

    // The same unit and the same route as the arrangement's, after the list
    // rather than in it: it is not a track (#76).
    const unit = screen.getByRole("group", { name: "Add track" });
    clickAndFlush(within(unit).getByRole("button", { name: "Add sampler track" }));

    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    // The new track is the one the view is showing.
    expect(rows()[1]).toHaveAttribute("aria-pressed", "true");
    expect(rows()[0]).toHaveAttribute("aria-pressed", "false");
    const added = transport.events.filter((event) => event.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toEqual(
      expect.objectContaining({ track_type: "instrument", instrument_type: "sampler" }),
    );
    // Its own key, apart from the arrangement's (#495).
    expect(firstUseKeys(transport)).toEqual(["instrument_add_track"]);
  });

  it("offers the Loop button on the instrument view's rail, opening the library on loops", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    await goToView("Instrument");
    const unit = screen.getByRole("group", { name: "Add track" });

    clickAndFlush(within(unit).getByRole("button", { name: "Add loop from library" }));

    const library = await screen.findByRole("region", { name: "Library" });
    expect(within(library).getByRole("heading", { name: "Loops" })).toBeVisible();
  });

  it("inserting a loop from the instrument view's rail adds an audio track", async () => {
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });
    await goToView("Instrument");
    const rows = () =>
      within(screen.getByRole("list", { name: "Tracks" })).getAllByRole("button", {
        name: /^Edit /,
      });
    const before = rows().length;

    clickAndFlush(
      within(screen.getByRole("group", { name: "Add track" })).getByRole("button", {
        name: "Add loop from library",
      }),
    );
    await screen.findByRole("region", { name: "Library" });
    const loopName = loopAssetName("core-electronic-drums");
    await insertSound(loopName);

    // The Insert button inserts and goes back, as Enter does (UI-002).
    await backFromInsert();
    await vi.waitFor(() => expect(rows()).toHaveLength(before + 1));
    const added = transport.events.filter((event) => event.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toEqual(expect.objectContaining({ track_type: "audio" }));
    // The new loop track is the selected one (#879): the view stays on the
    // instrument view, now showing what was just added, not the old track.
    expect(screen.getByRole("region", { name: `${loopName} loop` })).toBeInTheDocument();
  });

  it("opens the library on loops from the Loop button beside them", async () => {
    // An audio track needs content to exist, so the way to start one is to
    // pick the loop (UI-001).
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    await screen.findByTestId("arrangement-view-ready");

    clickAndFlush(screen.getByRole("button", { name: "Add loop from library" }));

    const library = await screen.findByRole("region", { name: "Library" });
    // It says what it is showing, without renaming the region underneath it.
    expect(within(library).getByRole("heading", { name: "Loops" })).toBeVisible();
    expect(within(library).getByRole("region", { name: "Browse sounds" })).toBeVisible();
    // Aimed at a new track, not at any slot (UI-002).
    expect(
      within(library).getByRole("heading", { name: "Inserting into a new track" }),
    ).toBeVisible();
  });

  it("inserting a loop adds a track carrying it, and goes back to the arrangement", async () => {
    // The regression this exists for: the Loop button opened the library, and
    // "Insert" reached a sampler-only path that returned silently because no
    // sampler was selected. The window closed, the project was untouched, and
    // nothing was logged or thrown — a dead end that looked like success.
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });
    await screen.findByTestId("arrangement-view-ready");
    const before = trackRows().length;
    // What the insert must leave alone, read off the screen beforehand.
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    const tempoBefore = (tempo as HTMLInputElement).value;
    const braceBefore = screen.getByTestId("arrangement-loop-live").textContent;

    clickAndFlush(screen.getByRole("button", { name: "Add loop from library" }));
    const library = await screen.findByRole("region", { name: "Library" });

    // The loop specifically: a one-shot takes the sampler path instead.
    expect(within(library).getByRole("heading", { name: "Loops" })).toBeVisible();
    const loopName = loopAssetName("core-electronic-drums");
    await insertSound(loopName);

    // The Insert button goes back to the arrangement it was asked from
    // (UI-002), where a track has appeared, named for the loop.
    await backFromInsert();
    await screen.findByTestId("arrangement-view-ready");
    await vi.waitFor(() => expect(trackRows()).toHaveLength(before + 1));
    expect(trackRows().at(-1)).toHaveTextContent(loopName);

    // One track_added, reporting an audio track and no instrument — the case
    // the catalog leaves `instrument_type` optional for.
    const added = transport.events.filter((event) => event.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toEqual(expect.objectContaining({ track_type: "audio" }));
    expect(added[0].params).not.toHaveProperty("instrument_type");
    // No param carries the sound's name — it is user-facing content.
    for (const event of transport.events) {
      expect(Object.values(event.params ?? {})).not.toContain(loopName);
    }

    // Nothing else moved (#281): the song tempo, the loop brace and whether it
    // loops, and the transport, which is still stopped.
    expect(tempo).toHaveValue(Number(tempoBefore));
    expect(screen.getByTestId("arrangement-loop-live").textContent).toBe(braceBefore);
    expect(screen.getByRole("button", { name: "Disable loop" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Start playback" })).toBeVisible();
    // Inserting a loop loads no sampler: the kind chose the other path.
    expect(transport.named("instrument_changed")).toHaveLength(0);
    // The new loop track is selected, like any other added track (#879).
    expect(
      within(screen.getByLabelText("Tracks")).getByRole("button", {
        name: `Edit ${loopName}`,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    // One undo takes the whole insertion back, track and all.
    clickAndFlush(screen.getByRole("button", { name: /^Undo / }));
    await vi.waitFor(() => expect(trackRows()).toHaveLength(before));
  });

  it("reaches the same outcome from the mixer, through the same route", async () => {
    const transport = createRecordingTransport();
    await renderSlice(transport);

    await goToView("Mixer");
    clickAndFlush(
      within(screen.getByRole("group", { name: "Add track" })).getByRole("button", {
        name: "Add synth track",
      }),
    );

    await goToView("Arrangement");
    await vi.waitFor(() => expect(trackRows()).toHaveLength(2));
    const added = transport.events.filter((event) => event.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toEqual(
      expect.objectContaining({ track_type: "instrument", instrument_type: "synth" }),
    );
  });
});

/** The sequence editor a clip opens into (`UI-001`, CF-001 and CF-008). */
describe("EditorView sequence editor", () => {
  async function renderSlice() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    return { ...renderEditor(project.metadata.id), project };
  }

  it("is not on the page until a clip is opened", async () => {
    await renderSlice();
    await screen.findByTestId("arrangement-view-ready");

    expect(screen.queryByRole("region", { name: "Sequence editor" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Step editor" })).not.toBeInTheDocument();
  });

  it("opens the double-clicked clip at its own address, in place of the arrangement", async () => {
    const { location, project } = await renderSlice();
    const editor = await openSequenceEditor();

    expect(within(editor).getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
    expect(location.get()).toBe(`/projects/${project.metadata.id}/sequence`);
    // One view at a time: the timeline is not behind it.
    expect(screen.queryByTestId("arrangement-view-ready")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    // A view, not a dialog: Escape leaves it where it is, and 1 goes back.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen.getByRole("region", { name: "Sequence editor" })).toBeInTheDocument();
    await leaveForArrangement();
  });

  it("opens the one selected clip with Enter, and logs how it was reached", async () => {
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const { location } = renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(transport),
    });
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");

    // Nothing selected: Enter opens nothing.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Enter" }));
    expect(location.get()).toBe(`/projects/${project.metadata.id}`);

    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Enter" }));

    const editor = await screen.findByRole("region", { name: "Sequence editor" });
    expect(within(editor).getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
    expect(location.get()).toBe(`/projects/${project.metadata.id}/sequence`);
    const switches = transport.events.filter((event) => event.name === "view_changed");
    expect(switches.map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "sequence", via: "arrangement" }),
    ]);
  });

  it("edits the clip a single click selected, on 2 (UI-002)", async () => {
    const { location, project } = await renderSlice();
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");

    // A click selects the clip and stays on the arrangement...
    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");
    expect(location.get()).toBe(`/projects/${project.metadata.id}`);

    // ...and 2 then edits it, with no double-click.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));
    const editor = await screen.findByRole("region", { name: "Sequence editor" });
    expect(within(editor).getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
  });

  it("keeps the clip selected across a visit to the sequence view (UI-002)", async () => {
    await renderSlice();
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");
    const selected = screen.getByTestId("arrangement-selection-live").textContent;
    expect(selected).not.toContain("No selection");

    fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));
    await screen.findByRole("region", { name: "Sequence editor" });
    fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
    await screen.findByTestId("arrangement-view-ready");

    expect(screen.getByTestId("arrangement-selection-live")).toHaveTextContent(
      selected ?? "",
    );
  });

  it("says no clip is selected on 2 before one is opened, and its button goes back", async () => {
    const { location, project } = await renderSlice();
    await screen.findByTestId("arrangement-view-ready");

    fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));
    const empty = await screen.findByRole("region", { name: "No clip selected" });
    expect(empty).toHaveTextContent(
      "Select a clip in the arrangement, then press 2 to edit its steps or notes.",
    );
    expect(location.get()).toBe(`/projects/${project.metadata.id}/sequence`);

    const back = within(empty).getByRole("button", { name: "Arrangement" });
    expect(back).toHaveTextContent("1");
    clickAndFlush(back);
    await screen.findByTestId("arrangement-view-ready");
    expect(location.get()).toBe(`/projects/${project.metadata.id}`);
  });

  it("logs the empty screen's way out once, as reached from the empty screen", async () => {
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    renderEditor(project.metadata.id, { analytics: recordingAnalytics(transport) });
    await screen.findByTestId("arrangement-view-ready");

    fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));
    const empty = await screen.findByRole("region", { name: "No clip selected" });
    clickAndFlush(within(empty).getByRole("button", { name: "Arrangement" }));
    await screen.findByTestId("arrangement-view-ready");

    expect(transport.named("view_changed").map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "sequence", via: "keyboard" }),
      expect.objectContaining({ view: "arrangement", via: "empty_screen" }),
    ]);
  });

  it("has no clip once another track is selected, rather than a stale one", async () => {
    await renderSlice();
    await openSequenceEditor();
    await leaveForArrangement();
    // A new track is selected as it is added (#495), so `2` has no clip.
    clickAndFlush(screen.getByRole("button", { name: "Add synth track" }));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));
    expect(
      await screen.findByRole("region", { name: "No clip selected" }),
    ).toBeInTheDocument();
  });

  it("keeps the transport and the view switches working while it is open", async () => {
    // It is `role="dialog"` to a screen reader but NOT the shortcut layer's
    // `dialog` context — the distinction UI-001 turns on, and the one a
    // `dialog` context would silently undo.
    const { location, project } = await renderSlice();
    await openSequenceEditor();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "5" }));
    await vi.waitFor(() =>
      expect(location.get()).toBe(`/projects/${project.metadata.id}/mixer`),
    );

    // The metronome rather than play/stop: both are `editor`-context transport
    // mappings, and this one settles synchronously where starting playback in
    // jsdom depends on an `AudioContext` that never resumes here.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "o" }));
    expect(screen.getByRole("button", { name: "Disable metronome" })).toBeVisible();
  });

  it("closes when the placement it was opened on goes away", async () => {
    await renderSlice();
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    // Select the placement, then open it: deleting it leaves the editor with
    // nothing to be open on, and it must go rather than sit on a clip the
    // project no longer places.
    // Delete it, bring it back, open it, then redo the delete: Delete itself
    // belongs to the open note editor (#643), so it cannot remove the clip.
    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Delete" }));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "z", ctrlKey: true }));
    await openSequenceEditor();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "y", ctrlKey: true }));

    await screen.findByRole("region", { name: "No clip selected" });
    expect(screen.queryByRole("region", { name: "Sequence editor" })).toBeNull();
  });

  it("keeps Backspace for the note editor's steps, never the clip under it (#643)", async () => {
    await renderSlice();
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");
    const editor = await openSequenceEditor();
    const on = () => editor.querySelectorAll(".step-cell.active").length;
    const notes = on();
    expect(notes).toBeGreaterThan(0);

    // Nothing selected: Backspace does nothing, and the clip stays open.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Backspace" }));
    expect(screen.getByRole("region", { name: "Sequence editor" })).toBeInTheDocument();
    expect(on()).toBe(notes);

    // With the steps selected it deletes them, and only them.
    clickAndFlush(within(editor).getByRole("button", { name: "Select all" }));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Backspace" }));
    expect(on()).toBe(0);
    expect(screen.getByRole("region", { name: "Sequence editor" })).toBeInTheDocument();
  });

  it("selects every note in the step grid with Cmd/Ctrl+A, not the page's text (#835)", async () => {
    await renderSlice();
    const editor = await openSequenceEditor();
    const on = () => editor.querySelectorAll(".step-cell.active").length;
    expect(on()).toBeGreaterThan(0);

    let prevented = false;
    fireAndFlush(() => {
      prevented = !fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    });
    expect(prevented).toBe(true);

    // Every note is now selected, so Backspace takes them all.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Backspace" }));
    expect(on()).toBe(0);
    expect(screen.getByRole("region", { name: "Sequence editor" })).toBeInTheDocument();
  });

  // The editor owns one pad selection for a drum track, and both the
  // instrument view's drum machine and the grid's row picker read and write it
  // (#643): neither side keeps its own.
  it("shares the selected pad between the drum machine and the grid's rows (#643)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    const rowButton = (editor: HTMLElement, name: string) =>
      within(within(editor).getByRole("group", { name: "Rows" })).getByRole("button", {
        name,
      });

    await goToView("Instrument");
    clickAndFlush(await screen.findByRole("button", { name: "Audition CP" }));
    expect(screen.getByRole("region", { name: "CP pad" })).toBeInTheDocument();

    await goToView("Arrangement");
    let editor = await openSequenceEditor();
    expect(rowButton(editor, "CP")).toHaveAttribute("aria-pressed", "true");
    expect(rowButton(editor, "BD")).toHaveAttribute("aria-pressed", "false");
    // Generate writes into that same row.
    expect(within(editor).getByRole("region", { name: "Generate" })).toHaveTextContent(
      "into CP",
    );

    // And back: a row picked in the grid is the pad the instrument view shows.
    clickAndFlush(rowButton(editor, "BD"));
    await goToView("Instrument");
    expect(await screen.findByRole("region", { name: "BD pad" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "CP pad" })).not.toBeInTheDocument();

    await goToView("Arrangement");
    editor = await openSequenceEditor();
    expect(rowButton(editor, "BD")).toHaveAttribute("aria-pressed", "true");
    expect(within(editor).getByRole("region", { name: "Generate" })).toHaveTextContent(
      "into BD",
    );
  });

  // The Sequence view's own way to add a lane (#947): [+ Pad] under the last
  // lane aims the Library at a new pad, and inserting comes back with its lane.
  describe("[+ Pad] (#947)", () => {
    async function renderDrums() {
      repository = inMemoryModule.createInMemoryProjectRepository();
      const project = createDrumMachineFixtureProject();
      const [drums] = project.song.tracks;
      if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
      const created = await repository.createProject(project);
      if (!created.ok) throw new Error("fixture project failed to create");
      const transport = createRecordingTransport();
      renderEditor(project.metadata.id, {
        libraryClient: new LibraryClient(fixtureFetcher()),
        analytics: recordingAnalytics(transport),
      });
      const editor = await openSequenceEditor();
      return { editor, transport, pads: drums.instrument.pads };
    }
    const rowNames = (editor: HTMLElement) =>
      within(within(editor).getByRole("group", { name: "Rows" }))
        .getAllByRole("button")
        .map((button) => button.textContent);

    it("adds a pad with the chosen sound, back on Sequence with its lane selected; one undo removes it", async () => {
      const { editor, transport, pads } = await renderDrums();
      clickAndFlush(within(editor).getByRole("button", { name: "Add pad from library" }));
      const library = await screen.findByRole("region", { name: "Library" });
      expect(library).toHaveTextContent("Drum machine › New pad");
      const oneShotName = oneShotAssetName("core-electronic-drums");
      await insertSound(oneShotName);

      // Back on Sequence, not the instrument, with the new lane last and selected.
      const sequence = await screen.findByRole("region", { name: "Sequence editor" });
      expect(screen.queryByRole("region", { name: "Library" })).not.toBeInTheDocument();
      expect(rowNames(sequence)).toEqual([...pads.map((pad) => pad.name), oneShotName]);
      expect(
        within(within(sequence).getByRole("group", { name: "Rows" })).getByRole(
          "button",
          {
            name: oneShotName,
          },
        ),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        within(sequence).getByRole("region", { name: "Generate" }),
      ).toHaveTextContent(`into ${oneShotName}`);

      // The event a pad given a sound logs, once, and the entry point's first use.
      const changed = transport.named("instrument_changed");
      expect(changed).toHaveLength(1);
      expect(changed[0].params.instrument_type).toBe("drum_machine");
      expect(
        transport
          .named("feature_first_use")
          .filter((event) => event.params.feature === "sequence_add_pad"),
      ).toHaveLength(1);

      fireAndFlush(() => fireEvent.keyDown(window, { key: "z", ctrlKey: true }));
      await vi.waitFor(() =>
        expect(rowNames(sequence)).toEqual(pads.map((pad) => pad.name)),
      );
    });

    it("leaving the Library without choosing adds nothing", async () => {
      const { editor, transport, pads } = await renderDrums();
      clickAndFlush(within(editor).getByRole("button", { name: "Add pad from library" }));
      await screen.findByRole("region", { name: "Library" });

      fireAndFlush(() => fireEvent.keyDown(window, { key: "2" }));

      const sequence = await screen.findByRole("region", { name: "Sequence editor" });
      expect(screen.queryByRole("region", { name: "Library" })).not.toBeInTheDocument();
      expect(rowNames(sequence)).toEqual(pads.map((pad) => pad.name));
      expect(transport.named("instrument_changed")).toHaveLength(0);
    });
  });
});
