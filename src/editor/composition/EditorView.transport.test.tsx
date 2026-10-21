import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import { createSliceFixtureProject } from "../../domain/fixtures";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import {
  createStepGridProject,
  goToView,
  loadEditorView,
  openSequenceEditor,
  paintStep,
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

/** The LOOP-003 transport surface: tempo, 4/4 display, loop, and metronome. */
describe("EditorView transport controls (PRD AUD-01/AUD-02)", () => {
  async function renderSlice() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await openSequenceEditor();
    return project;
  }

  it("shows a starting playhead and no time signature", async () => {
    await renderSlice();
    // The playhead's readout is a visually hidden sentence beside its
    // bar/beat inputs; the fixed 4/4 display was dropped (#340).
    expect(screen.queryByText("4/4", { exact: false })).toBeNull();
    expect(screen.getByTitle("Playhead (bar.beat)")).toHaveTextContent(
      "Playhead at bar 1.1",
    );
  });

  it("toggles the loop and the metronome, reflecting their pressed state", async () => {
    await renderSlice();

    // A new project loops by default (LOOP-017), and the toggle is a song
    // edit: it goes through the command layer, so it lands on the undo stack.
    const loop = screen.getByRole("button", { name: "Disable loop" });
    expect(loop).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(loop);
    const loopOff = await screen.findByRole("button", { name: "Enable loop" });
    expect(loopOff).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Undo Turn looping off" })).toBeEnabled();

    const metronome = screen.getByRole("button", { name: "Enable metronome" });
    expect(metronome).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(metronome);
    const metronomeOn = await screen.findByRole("button", {
      name: "Disable metronome",
    });
    expect(metronomeOn).toHaveAttribute("aria-pressed", "true");
  });

  describe("swing (#500)", () => {
    const swingButton = () => screen.getByRole("button", { name: "Swing" });
    const openSwing = async () => {
      if (swingButton().getAttribute("aria-expanded") !== "true") {
        fireEvent.click(swingButton());
      }
      await screen.findByRole("slider", { name: "Swing" });
    };
    const swingSlider = () => screen.getByRole("slider", { name: "Swing" });
    const swingField = () => screen.getByRole("textbox", { name: "Swing value" });

    it("shows the song's swing and writes a drag as one undoable, clamped edit", async () => {
      await renderSlice();
      await openSwing();
      expect(swingSlider()).toHaveAttribute("min", "50");
      expect(swingSlider()).toHaveAttribute("max", "75");
      expect(swingField()).toHaveValue("50%");

      // A pointer drag: several `input` steps, then the settling `change`.
      fireEvent.input(swingSlider(), { target: { value: "58" } });
      fireEvent.input(swingSlider(), { target: { value: "66" } });
      fireEvent.change(swingSlider(), { target: { value: "66" } });

      await waitFor(() => expect(swingField()).toHaveValue("66%"));
      expect(swingSlider()).toHaveAttribute("aria-valuetext", "66%");
      const undo = await screen.findByRole("button", { name: "Undo Set swing" });
      fireEvent.click(undo);
      await waitFor(() => expect(swingField()).toHaveValue("50%"));
      // One gesture, one history entry: nothing is left to undo.
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });

    it("takes a typed value from the keyboard and clamps it to 75%", async () => {
      await renderSlice();
      await openSwing();
      fireEvent.change(swingField(), { target: { value: "99" } });
      await waitFor(() => expect(swingField()).toHaveValue("75%"));
    });

    it("emits feature_first_use once per session, and nothing when analytics is off", async () => {
      const transport = createRecordingTransport();
      repository = inMemoryModule.createInMemoryProjectRepository();
      const project = createSliceFixtureProject();
      await repository.createProject(project);
      renderEditor(project.metadata.id, { analytics: recordingAnalytics(transport) });
      await openSequenceEditor();
      await openSwing();

      fireEvent.change(swingSlider(), { target: { value: "60" } });
      fireEvent.change(swingSlider(), { target: { value: "62" } });
      await waitFor(() => expect(swingField()).toHaveValue("62%"));
      const swings = transport.events.filter(
        (event) => event.name === "feature_first_use" && event.params.feature === "swing",
      );
      expect(swings).toHaveLength(1);
    });

    it("changes nothing else when analytics is disabled", async () => {
      const transport = createRecordingTransport();
      const consent = new ConsentStore(memoryStorage());
      consent.set({ productAnalytics: false });
      repository = inMemoryModule.createInMemoryProjectRepository();
      const project = createSliceFixtureProject();
      await repository.createProject(project);
      renderEditor(project.metadata.id, {
        analytics: recordingAnalytics(transport, consent),
      });
      await openSequenceEditor();
      await openSwing();

      fireEvent.change(swingSlider(), { target: { value: "70" } });
      await waitFor(() => expect(swingField()).toHaveValue("70%"));
      expect(transport.events).toHaveLength(0);
    });
  });

  it("dispatches a clamped tempo command from the BPM input", async () => {
    await renderSlice();
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    expect(tempo).toHaveAttribute("min", "40");
    expect(tempo).toHaveAttribute("max", "240");

    // 999 is above the supported range, so the command records the clamped 240.
    fireEvent.change(tempo, { target: { value: "999" } });

    const undo = await screen.findByRole("button", {
      name: "Undo Set Tempo to 240 BPM",
    });
    expect(undo).not.toBeDisabled();
    // The input reads back from `song.tempo`, so the displayed value proves the
    // command is the path the tempo travelled — this surface never writes it a
    // second time straight onto the transport.
    expect(tempo).toHaveValue(240);
  });

  /** The slice fixture, with a recording analytics transport (LOOP-018). */
  async function renderLooping() {
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, { analytics: recordingAnalytics(transport) });
    await screen.findByTestId("arrangement-view-ready");
    return transport;
  }

  it("Shift+L toggles looping from the keyboard, like the button, once per press", async () => {
    const transport = await renderLooping();
    const loop = screen.getByRole("button", { name: "Disable loop" });
    // The tooltip names the key, and it comes from the registry.
    expect(loop).toHaveAttribute("title", "Disable loop (Shift+L)");

    fireEvent.keyDown(window, { key: "L", shiftKey: true });

    const off = await screen.findByRole("button", { name: "Enable loop" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("arrangement-loop-live")).toHaveTextContent(
      "Loop over bar 1, looping off",
    );
    expect(transport.named("loop_toggled")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo Turn looping off" })).toBeEnabled();
  });

  it("zooms with +, - and Shift+Z (the whole song), the keys of the zoom group's buttons", async () => {
    await renderLooping();
    const root = screen.getByTestId("arrangement-view-ready");
    const scale = () => Number(root.getAttribute("data-pixels-per-tick"));
    const before = scale();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "+", shiftKey: true }));
    expect(scale()).toBeGreaterThan(before);
    fireAndFlush(() => fireEvent.keyDown(window, { key: "-" }));
    expect(scale()).toBeCloseTo(before);
    // The starter song is one bar long, so it fills jsdom's 960px viewport.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Z", shiftKey: true }));
    expect(scale()).toBeCloseTo(960 / 768);
  });

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("exposes the loop brace as a focusable slider described by the range readout", async () => {
    await renderLooping();
    const live = screen.getByTestId("arrangement-loop-live");
    const brace = screen.getByRole("slider", { name: "Loop brace" });
    expect(brace).toHaveAttribute("tabindex", "0");
    expect(brace).toHaveAttribute("aria-valuenow", "1");
    expect(brace).toHaveAttribute("aria-valuetext", "bar 1");
    expect(brace).toHaveAttribute("aria-describedby", live.id);
    expect(screen.queryByRole("spinbutton", { name: "Loop start" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Loop length" })).toBeNull();
  });

  it("moves and resizes the focused loop brace with the arrow keys, one command per press", async () => {
    const transport = await renderLooping();
    const live = screen.getByTestId("arrangement-loop-live");
    const brace = screen.getByRole("slider", { name: "Loop brace" });
    const press = async (key: string, shiftKey = false) => {
      fireEvent.keyDown(brace, { key, shiftKey });
      await settle();
    };
    brace.focus();
    // Solid batches the focus write: the keys see it a tick later.
    await settle();

    // Shift+Right lengthens from the end edge: bar 1 becomes bars 1 to 2.
    await press("ArrowRight", true);
    await screen.findByRole("button", { name: "Undo Loop bars 1-2" });
    expect(live).toHaveTextContent("Loop over bars 1 to 2, looping on");
    // Right moves the whole brace a bar, keeping its length.
    await press("ArrowRight");
    await screen.findByRole("button", { name: "Undo Loop bars 2-3" });
    expect(live).toHaveTextContent("Loop over bars 2 to 3, looping on");
    expect(brace).toHaveAttribute("aria-valuenow", "2");
    expect(brace).toHaveAttribute("aria-valuetext", "bars 2 to 3");
    // Left moves back; at the top of the song it stops rather than going negative.
    await press("ArrowLeft");
    await press("ArrowLeft");
    await screen.findByRole("button", { name: "Undo Loop bars 1-2" });
    expect(live).toHaveTextContent("Loop over bars 1 to 2, looping on");
    // Shift+Left shortens down to one bar and no further.
    await press("ArrowLeft", true);
    await press("ArrowLeft", true);
    expect(live).toHaveTextContent("Loop over bar 1, looping on");

    // One event per press that changed the range; the clamped ones logged none.
    expect(
      transport.named("loop_range_set").map((event) => event.params.bar_count),
    ).toEqual([2, 2, 2, 1]);
  });

  it("leaves Left and Right to the rest of the editor when the brace is not focused", async () => {
    const transport = await renderLooping();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByTestId("arrangement-loop-live")).toHaveTextContent(
      "Loop over bar 1, looping on",
    );
    expect(transport.named("loop_range_set")).toHaveLength(0);

    const brace = screen.getByRole("slider", { name: "Loop brace" });
    brace.focus();
    await settle();
    brace.blur();
    await settle();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("arrangement-loop-live")).toHaveTextContent(
      "Loop over bar 1, looping on",
    );
  });

  it("the metronome shortcut O toggles the click from the keyboard", async () => {
    await renderSlice();
    expect(screen.getByRole("button", { name: "Enable metronome" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "o" });

    expect(
      await screen.findByRole("button", { name: "Disable metronome" }),
    ).toBeInTheDocument();
  });
});

/** The three views and the dock that names them (`UI-001`, CF-008). */
describe("EditorView views", () => {
  async function renderViews(analytics?: Analytics) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const rendered = renderEditor(project.metadata.id, { analytics });
    await screen.findByTestId("arrangement-view-ready");
    return { ...rendered, projectId: project.metadata.id };
  }

  const dock = () => screen.getByRole("navigation", { name: "Views" });
  const currentView = () => dock().querySelector("[aria-current='page']");
  const viewLink = (name: string) => within(dock()).getByRole("link", { name });

  /** Router 2 navigates on its own schedule, so the address and the dock's
   * marker are awaited together rather than read the instant an event fires. */
  async function atView(
    location: { get(): string; back(): void },
    path: string,
    label: string,
  ): Promise<void> {
    await vi.waitFor(() => {
      expect(location.get()).toBe(path);
      expect(currentView()).toHaveAccessibleName(label);
    });
  }

  it("opens a project on the arrangement, at the bare project address", async () => {
    const { location, projectId } = await renderViews();

    expect(location.get()).toBe(`/projects/${projectId}`);
    expect(currentView()).toHaveAccessibleName("Arrangement");
  });

  it("moves to a view from the dock, and the address follows", async () => {
    const { location, projectId } = await renderViews();

    clickAndFlush(viewLink("Mixer"));

    await atView(location, `/projects/${projectId}/mixer`, "Mixer");
  });

  it("moves to a view with its key, through the shortcut registry", async () => {
    const { location, projectId } = await renderViews();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "3" }));
    await atView(location, `/projects/${projectId}/instrument`, "Instrument");

    fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
    await atView(location, `/projects/${projectId}`, "Arrangement");
  });

  it("moves back through the views with the browser's back button", async () => {
    // A view is an address, so the history stack is what moving between them
    // produces — the half of "in the URL" a session-scoped signal would fail.
    const { location, projectId } = await renderViews();

    clickAndFlush(viewLink("Mixer"));
    await atView(location, `/projects/${projectId}/mixer`, "Mixer");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "3" }));
    await atView(location, `/projects/${projectId}/instrument`, "Instrument");

    location.back();
    await atView(location, `/projects/${projectId}/mixer`, "Mixer");
    location.back();
    await atView(location, `/projects/${projectId}`, "Arrangement");
  });

  it("logs view_changed once per switch, saying how the view was reached", async () => {
    const transport = createRecordingTransport();
    await renderViews(recordingAnalytics(transport));

    clickAndFlush(viewLink("Mixer"));
    await vi.waitFor(() => expect(currentView()).toHaveAccessibleName("Mixer"));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "3" }));
    await vi.waitFor(() => expect(currentView()).toHaveAccessibleName("Instrument"));

    const switches = transport.events.filter((event) => event.name === "view_changed");
    expect(switches.map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "mixer", via: "dock" }),
      expect.objectContaining({ view: "instrument", via: "keyboard" }),
    ]);
  });

  it("logs nothing for arriving, or for asking for the view already on screen", async () => {
    const transport = createRecordingTransport();
    await renderViews(recordingAnalytics(transport));

    // Opening a project is not a switch — `project_opened` measures that.
    expect(transport.events.some((event) => event.name === "view_changed")).toBe(false);

    clickAndFlush(viewLink("Arrangement"));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
    await Promise.resolve();

    expect(transport.events.some((event) => event.name === "view_changed")).toBe(false);
  });

  it("keeps one editing session across a switch, rather than remounting", async () => {
    const { location, projectId } = await renderViews();

    // Undo history is session-local and dies with the component, so an undo
    // that survives a switch is proof the editor was not remounted — which is
    // what "switching views never rebuilds audio nodes or loses transport
    // position" rests on, since the audio graph has the same lifetime.
    await openSequenceEditor();
    paintStep("BD, step 2, off");
    await screen.findByRole("button", { name: "BD, step 2, on" });
    const undoBefore = screen.getByRole("button", { name: /^Undo / });

    clickAndFlush(viewLink("Mixer"));
    await atView(location, `/projects/${projectId}/mixer`, "Mixer");

    const undoAfter = screen.getByRole("button", { name: /^Undo / });
    expect(undoAfter).toBeEnabled();
    expect(undoAfter.getAttribute("aria-label")).toBe(
      undoBefore.getAttribute("aria-label"),
    );
  });

  it("changes nothing about switching when analytics is disabled", async () => {
    const transport = createRecordingTransport();
    const consent = new ConsentStore(memoryStorage());
    consent.set({ productAnalytics: false });
    const { location, projectId } = await renderViews(
      recordingAnalytics(transport, consent),
    );

    clickAndFlush(viewLink("Mixer"));

    await atView(location, `/projects/${projectId}/mixer`, "Mixer");
    expect(transport.events).toHaveLength(0);
  });
});

describe("EditorView focus rescue (#76)", () => {
  async function renderOpen() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
  }

  it("puts focus on the arrangement when the view that held it goes", async () => {
    await renderOpen();
    await goToView("Mixer");
    const fader = screen.getByRole("slider", { name: /^Volume for / });
    fader.focus();

    // `1` swaps the mixer, and the fader with it, out for the arrangement.
    fireAndFlush(() => fireEvent.keyDown(fader, { key: "1", bubbles: true }));

    const arrangement = await screen.findByTestId("arrangement-view-ready");
    await vi.waitFor(() => expect(document.activeElement).toBe(arrangement));
  });

  it("puts focus on the view's body when the element that held it goes", async () => {
    await renderOpen();
    screen.getAllByRole("button", { name: /^Edit / })[0]?.focus();

    fireAndFlush(() => fireEvent.keyDown(window, { key: "5" }));

    await screen.findByRole("region", { name: "Mixer" });
    await vi.waitFor(() => expect(document.activeElement).toHaveClass("editor-body"));
  });
});
