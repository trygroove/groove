import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { INITIAL_PIXELS_PER_TICK } from "../../arrangement/ArrangementView";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { toTicks } from "../../domain/time";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { LibraryClient } from "../../library/libraryClient";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { detectPlatform, shortcutLabel } from "../../shortcuts";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  createStepGridProject,
  firePointerAtStarterClip,
  goToView,
  leaveForArrangement,
  leaveLibrary,
  loadEditorView,
  mixerSelect,
  openLibrary,
  openSequenceEditor,
  paintStep,
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

/** The PRD KEY-01/KEY-02 wiring, end to end through the real registry. */
describe("EditorView track selection keys (#533)", () => {
  async function renderDrums(view: "Arrangement" | "Instrument" | "Mixer") {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    if (view !== "Arrangement") await goToView(view);
    const [drums, breakTrack] = project.song.tracks;
    return { drums, breakTrack };
  }

  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireAndFlush(() => fireEvent.keyDown(window, { key, ...init }));
  const instrumentShows = (label: string) =>
    screen.queryByRole("region", { name: label });

  it("steps through the tracks in the instrument view and stops at both ends", async () => {
    const { drums, breakTrack } = await renderDrums("Instrument");
    const drumRegion = `Drum machine: ${drums.name}`;
    const breakRegion = `${breakTrack.name} loop`;
    expect(instrumentShows(drumRegion)).toBeInTheDocument();

    press("ArrowUp"); // already first: no wrap to the last track
    expect(instrumentShows(drumRegion)).toBeInTheDocument();
    press("ArrowDown");
    expect(instrumentShows(breakRegion)).toBeInTheDocument();
    press("ArrowDown"); // already last: no wrap to the first track
    expect(instrumentShows(breakRegion)).toBeInTheDocument();
    press("ArrowUp");
    expect(instrumentShows(drumRegion)).toBeInTheDocument();
  });

  it("steps the selection in the arrangement view too, which the other views follow", async () => {
    const { drums, breakTrack } = await renderDrums("Arrangement");

    press("ArrowDown");

    await goToView("Instrument");
    expect(instrumentShows(`${breakTrack.name} loop`)).toBeInTheDocument();
    expect(instrumentShows(`Drum machine: ${drums.name}`)).not.toBeInTheDocument();
  });

  it("leaves Alt+Arrow to the device move and the mixer's own arrow keys alone", async () => {
    const { drums, breakTrack } = await renderDrums("Instrument");

    press("ArrowDown", { altKey: true });
    expect(instrumentShows(`Drum machine: ${drums.name}`)).toBeInTheDocument();

    await goToView("Mixer");
    press("ArrowDown");
    expect(mixerSelect(drums.name)).toHaveAttribute("aria-pressed", "true");
    expect(mixerSelect(breakTrack.name)).toHaveAttribute("aria-pressed", "false");
  });

  const trackButton = (name: string) =>
    screen.queryByRole("button", { name: `Edit ${name}` });

  it("Backspace deletes the selected track, selects the next, and undo brings it back (#537)", async () => {
    const { drums, breakTrack } = await renderDrums("Instrument");
    expect(trackButton(drums.name)).toBeInTheDocument();

    press("Backspace");
    expect(trackButton(drums.name)).toBeInTheDocument();

    await fireAndFlush(() => fireEvent.click(trackButton(drums.name) as HTMLElement));
    press("Backspace");

    expect(trackButton(drums.name)).not.toBeInTheDocument();
    expect(instrumentShows(`${breakTrack.name} loop`)).toBeInTheDocument();

    press("z", { ctrlKey: true });
    expect(trackButton(drums.name)).toBeInTheDocument();
  });

  it("deletes from the arrangement view too, and leaves the mixer alone (#537)", async () => {
    const { drums, breakTrack } = await renderDrums("Arrangement");
    await fireAndFlush(() => fireEvent.click(trackButton(drums.name) as HTMLElement));
    press("Backspace");
    expect(trackButton(drums.name)).not.toBeInTheDocument();
    expect(trackButton(breakTrack.name)).toBeInTheDocument();
    press("z", { ctrlKey: true });

    await goToView("Mixer");
    press("Backspace");
    expect(mixerSelect(drums.name)).toBeInTheDocument();
    expect(mixerSelect(breakTrack.name)).toBeInTheDocument();
  });

  it("keeps Backspace for a selected placement rather than the track (#537)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    firePointerAtStarterClip(canvas, "pointerdown");
    firePointerAtStarterClip(canvas, "pointerup");

    press("Backspace");

    expect(trackButton(project.song.tracks[0].name)).toBeInTheDocument();
  });
});

/** Return mode (#386): the instrument view showing a return's chain. */
describe("EditorView return mode (#386)", () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireAndFlush(() => fireEvent.keyDown(window, { key, ...init }));
  const returnEffects = () => screen.queryByRole("region", { name: "Return effects" });
  const railTrack = (name: string) =>
    within(screen.getByRole("list", { name: "Tracks" })).queryByRole("button", {
      name: `Edit ${name}`,
    });

  /** Chooses the first track in the mixer, adds Return A, and edits it. */
  async function enterReturnMode() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    await goToView("Mixer");
    const [drums, breakTrack] = project.song.tracks;
    clickAndFlush(mixerSelect(drums.name));
    clickAndFlush(screen.getByRole("button", { name: "Add return" }));
    clickAndFlush(screen.getByRole("button", { name: "Edit Return A" }));
    await goToView("Instrument");
    expect(returnEffects()).toBeInTheDocument();
    return { drums, breakTrack };
  }

  it("leaves the tracks alone on Backspace, since none is on screen", async () => {
    const { drums, breakTrack } = await enterReturnMode();
    press("Backspace");
    expect(returnEffects()).toBeInTheDocument();
    expect(railTrack(drums.name)).toBeInTheDocument();
    expect(railTrack(breakTrack.name)).toBeInTheDocument();
  });

  it("leaves return mode when a track is selected", async () => {
    const { breakTrack } = await enterReturnMode();
    clickAndFlush(railTrack(breakTrack.name) as HTMLElement);
    expect(returnEffects()).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: `${breakTrack.name} loop` }),
    ).toBeInTheDocument();
  });

  it("falls back to the track when its return is deleted, and undo does not go back", async () => {
    const { drums } = await enterReturnMode();
    await goToView("Mixer");
    clickAndFlush(screen.getByRole("button", { name: "Delete Return A" }));
    await goToView("Instrument");
    expect(returnEffects()).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).toBeInTheDocument();

    press("z", { ctrlKey: true });
    expect(returnEffects()).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).toBeInTheDocument();
  });
});

describe("EditorView keyboard shortcuts", () => {
  async function renderSlice(
    project: Project = createStepGridProject(),
    options: Parameters<typeof renderEditor>[1] = {},
  ) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, options);
    await openSequenceEditor();
    return project;
  }

  it("undoes an edit from the keyboard, through the same command path as the button", async () => {
    await renderSlice();

    paintStep("BD, step 2, off");
    await screen.findByRole("button", { name: "BD, step 2, on" });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(
      await screen.findByRole("button", { name: "BD, step 2, off" }),
    ).toBeInTheDocument();
  });

  it("does nothing when the undo shortcut fires with nothing to undo", async () => {
    await renderSlice();

    // Undo is registered but disabled, so the mapping resolves and stops.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "BD, step 1, on" })).toBeInTheDocument();
  });

  it("does not fire a shortcut typed into a text field", async () => {
    await renderSlice();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    fireEvent.keyDown(input, { key: "?" });

    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeInTheDocument();
    input.remove();
  });

  it("opens the mapping guide with ?, closes it with Escape, and restores focus", async () => {
    await renderSlice();
    const opener = screen.getByRole("button", { name: "Keyboard shortcuts" });
    opener.focus();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(screen.getByLabelText("Search shortcuts"));

    fireEvent.keyDown(window, { key: "Escape" });

    await vi.waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
      ).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(opener);
  });

  it("does not toggle playback while the guide is open", async () => {
    await renderSlice();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    fireEvent.keyDown(window, { key: " " });

    // The transport button still offers Play, so Space never reached it.
    expect(screen.getByRole("button", { name: "Start playback" })).toBeInTheDocument();
  });

  it("keeps editor keys off while the library is open, gives it its own, and 1 leaves it", async () => {
    await renderSlice(createSliceFixtureProject(), {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });

    // A modal surface takes the keyboard like the guide (PRD KEY-02).
    await openLibrary();

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: "Start playback" })).toBeInTheDocument();

    // `P` browses packs, a cover opens one, and Backspace steps back out.
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Core Electronic Drums" }),
    );
    await screen.findByRole("heading", { name: "Core Electronic Drums" });
    fireEvent.keyDown(window, { key: "Backspace" });
    await screen.findByRole("region", { name: "Packs" });
    fireEvent.keyDown(window, { key: "Backspace" });
    await screen.findByRole("region", { name: "Browse sounds" });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
    await leaveLibrary("1");
    // With the Library gone the editor context has the keyboard back: `?` is an
    // `editor`-context mapping, so it only fires once nothing is suppressing it.
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(
      await screen.findByRole("searchbox", { name: "Search shortcuts" }),
    ).toBeInTheDocument();
  });

  // #813: `?` (and the footer's ? button) in the library opens its own keys,
  // not the editor's guide, and Escape closes that sheet before the library.
  it("lists the library's own keys from ?, and Escape steps out of them first", async () => {
    await renderSlice(createSliceFixtureProject(), {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    const library = await openLibrary();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    const keys = await within(library).findByRole("dialog", { name: "Library keys" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    for (const group of ["Sounds", "Categories", "Where you are"]) {
      expect(within(keys).getByRole("heading", { name: group })).toBeVisible();
    }
    expect(within(keys).getByText("Similar sounds")).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Library keys" })).toBeNull(),
    );
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();

    clickAndFlush(within(library).getByRole("button", { name: "Keyboard shortcuts" }));
    expect(within(library).getByRole("dialog", { name: "Library keys" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  // #874: Escape with the genre menu open closes only the menu, hands focus
  // back to its button, and leaves the library open. The library is a view
  // (UI-002), so a second Escape does not leave it either.
  it("closes the genre menu on Escape before the library", async () => {
    await renderSlice(createSliceFixtureProject(), {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    const library = await openLibrary();

    fireEvent.keyDown(window, { key: "g" });
    await within(library).findByRole("group", { name: "Genres" });

    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("group", { name: "Genres" })).toBeNull(),
    );
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
    const genreButton = within(library).getByRole("button", { name: /Any genre/ });
    expect(genreButton).toHaveAttribute("aria-expanded", "false");
    expect(genreButton).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
  });

  it("gives the keyboard to the Export dialog while it is open, and back on Escape", async () => {
    await renderSlice();

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    await screen.findByRole("dialog", { name: "Export" });

    // `?` is an editor mapping, so it only opens the guide once nothing modal
    // is suppressing the editor's keys.
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    // The guide is lazily loaded, so give it the time it would take to appear.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("searchbox", { name: "Search shortcuts" })).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Export" })).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(
      await screen.findByRole("searchbox", { name: "Search shortcuts" }),
    ).toBeInTheDocument();
  });

  it("shows each action's mapping in its tooltip, from the registry", async () => {
    await renderSlice();

    const platform = detectPlatform();
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute(
      "title",
      `Undo (${shortcutLabel("edit.undo", platform)})`,
    );
    expect(screen.getByRole("button", { name: "Start playback" })).toHaveAttribute(
      "title",
      "Play (Space)",
    );
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toHaveAttribute(
      "title",
      "Keyboard shortcuts (?)",
    );
  });

  it("cancels an Alt-drag with Escape before it closes anything (ARR-011)", async () => {
    await renderSlice();
    await leaveForArrangement();
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    const at = (type: string, bar: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        altKey: true,
        clientX: (bar - 0.5) * 768 * 0.08,
        clientY: 22 + 28 / 2,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireAndFlush(() => fireEvent(canvas, event));
    };
    at("pointerdown", 1);
    at("pointermove", 3);
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeDisabled();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "Escape" }));
    at("pointerup", 3);
    // The drag is gone, and nothing changed.
    expect(screen.getByTestId("arrangement-view-ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByTestId("arrangement-selection-live")).toHaveTextContent(
      "No selection",
    );
  });

  it("deletes a selected arrangement placement from the keyboard (ARR-002)", async () => {
    const project = await renderSlice();
    const placementId = project.song.placements[0].id;
    // This block opens the sequence view, which owns Delete while it is up
    // (#643); leave it so the key reaches the arrangement.
    await leaveForArrangement();

    // Select the fixture's one placement (tick 0..TICKS_PER_BAR, row 0) by
    // pointer, the same way a user would, then delete it with the KEY-01
    // mapping — not by calling the controller directly, so this proves the
    // arrangement shortcut context actually reaches the command layer.
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    const PIXELS_PER_TICK = 0.08;
    const RULER_HEIGHT_PX = 22;
    const ROW_HEIGHT_PX = 28;
    const TICKS_PER_BAR = 768;
    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });
    Object.defineProperty(down, "pointerId", { value: 1 });
    fireEvent(canvas, down);
    const up = new MouseEvent("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "pointerId", { value: 1 });
    fireEvent(canvas, up);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-selected-placement="${placementId}"]`),
      ).not.toBeNull();
    });

    fireEvent.keyDown(window, { key: "Delete" });
    await screen.findByText("Saved", {}, { timeout: 3_000 });

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(
      loaded.value.song.placements.find((p) => p.id === placementId),
    ).toBeUndefined();
  });

  // #292: cut left nothing selected, and the `arrangement` context was only
  // added for a selection that covered clips, so with the step editor showing
  // (no `selection` context of its own) Mod+V matched no shortcut at all.
  it("pastes after a cut with the step editor showing (#292)", async () => {
    const project = await renderSlice();
    await leaveForArrangement();
    const [source] = project.song.placements;
    await selectPlacementInArrangement(source.id);

    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    await waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        expect(loaded.value.song.placements).toEqual([]);
      },
      { timeout: 3_000 },
    );
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        const starts = loaded.value.song.placements.map((p) => p.startTicks);
        expect(starts).toEqual([source.startTicks]);
      },
      { timeout: 3_000 },
    );
  });

  it("zooms the arrangement to its selection with Z, and not without one (#292)", async () => {
    await renderSlice();
    await leaveForArrangement();
    const root = await screen.findByTestId("arrangement-view-ready");
    const scale = () => Number(root.getAttribute("data-pixels-per-tick"));
    const before = scale();

    // Nothing selected: Z has nothing to frame, so nothing changes.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "z" }));
    expect(scale()).toBe(before);

    // Select BD's clip in bar 1 from the accessible track list, then press Z:
    // that bar now spans the whole timeline (jsdom's viewport is 960px).
    clickAndFlush(screen.getByRole("button", { name: "Select BD" }));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "z" }));
    expect(scale()).toBeCloseTo(960 / 768);
  });

  /**
   * Clicks the first bar of the first arrangement row, where the piano-roll
   * fixture's placement sits, and waits for the accessible selection mirror to
   * show it. The geometry constants mirror the renderer's own — the canvas has
   * no DOM nodes to query for a hit.
   */
  async function selectPlacementInArrangement(
    placementId: string,
    atTicks = 768 / 2,
  ): Promise<void> {
    clickArrangementAt(atTicks);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-selected-placement="${placementId}"]`),
      ).not.toBeNull();
    });
  }

  /** A bare click on the first arrangement row, at a tick. */
  function clickArrangementAt(atTicks: number): void {
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    const PIXELS_PER_TICK = INITIAL_PIXELS_PER_TICK;
    const RULER_HEIGHT_PX = 22;
    const ROW_HEIGHT_PX = 28;
    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: atTicks * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });
    Object.defineProperty(down, "pointerId", { value: 1 });
    fireEvent(canvas, down);
    const up = new MouseEvent("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "pointerId", { value: 1 });
    fireEvent(canvas, up);
  }

  // #258. The reporter hit this by selecting a placement on one track, deleting
  // it, then selecting one on another track — but moving between tracks is
  // incidental. What decides it is the *edited* track's instrument, which
  // clicking a placement re-points (#228): once that track is one the editor
  // shows the piano roll for, the arrangement's placement selection stopped
  // reaching `edit.delete` at all, so Delete did nothing. The piano-roll
  // fixture is the smallest case — one synth track, one placement, no track
  // switching anywhere.
  it("deletes a selected placement while the piano roll is showing (#258)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createPianoRollFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");

    const placementId = project.song.placements[0].id;
    await selectPlacementInArrangement(placementId);

    fireEvent.keyDown(window, { key: "Delete" });

    // Asserted against the stored project rather than the "Saved" indicator, so
    // a failure names the placement that is still there instead of dumping the
    // editor's DOM.
    await waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        expect(loaded.value.song.placements.map((p) => p.id)).not.toContain(placementId);
      },
      { timeout: 3_000 },
    );
  });

  // #258 again, found by walking the preview channel: Delete, Cut and Copy all
  // came back, but Paste stayed dead on a piano-roll track. Its `isEnabled`
  // carried the same `!showPianoRoll()` term the rest of this handler block
  // shed — and because a disabled mapping leaves the browser default alone,
  // the failure is silent. The registry lists `edit.paste` under both
  // `selection` and `arrangement`, so the context was active the whole time
  // and only this gate stood in the way. Nothing is stolen from the roll: it
  // registers no clipboard action of its own (`PianoRollActions` is delete,
  // duplicate, select-all, has-selection).
  /** The piano-roll fixture with its one placement moved to bar 2. */
  async function openWithPlacementInBar2() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const fixture = createPianoRollFixtureProject();
    const [source] = fixture.song.placements;
    const moved = { ...source, startTicks: toTicks(768), durationTicks: toTicks(768) };
    const project = { ...fixture, song: { ...fixture.song, placements: [moved] } };
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    await selectPlacementInArrangement(source.id, 768 * 1.5);
    return project.metadata.id;
  }

  /** Waits until the stored placements start at exactly these ticks. */
  async function expectStoredStarts(
    projectId: Parameters<InMemoryProjectRepository["loadProject"]>[0],
    starts: number[],
  ): Promise<void> {
    await waitFor(
      async () => {
        const loaded = await repository.loadProject(projectId);
        if (!loaded.ok) throw new Error("expected the project to load");
        const stored = loaded.value.song.placements.map((p) => p.startTicks);
        expect(stored.sort((a, b) => a - b)).toEqual(starts);
      },
      { timeout: 3_000 },
    );
  }

  // Paste lands at the selection's start (#292), so the copy goes where the
  // click put the insertion point: bar 4, clear of its source in bar 2. It
  // used to go to the playhead in bar 1, whatever was clicked.
  it("pastes a copy at an empty bar clicked after copying (#258, #292)", async () => {
    const projectId = await openWithPlacementInBar2();

    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    clickArrangementAt(768 * 3);
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await expectStoredStarts(projectId, [768, 768 * 3]);
  });

  // #493: Cmd/Ctrl+D is the independent duplicate. It forks the clip, so the
  // copy in bar 3 has a clip of its own instead of sharing its source's.
  it("Ctrl+D duplicates the selected clip as an independent copy (#493)", async () => {
    const projectId = await openWithPlacementInBar2();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    await expectStoredStarts(projectId, [768, 768 * 2]);
    const loaded = await repository.loadProject(projectId);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clipIds = loaded.value.song.placements.map((p) => p.clipId);
    expect(new Set(clipIds).size).toBe(2);
  });
});
