import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analytics as defaultAnalytics } from "../../analytics";
import { INITIAL_PIXELS_PER_TICK, ROW_METRICS } from "../../arrangement/ArrangementView";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { buildArrangementProject } from "../../testing/arrangementProject";
import { fireAndFlush } from "../../testing/events";
import { loadEditorView, renderEditor } from "./EditorView.testHarness";

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
 * Select all in the arrangement (#835, CF-029): Cmd/Ctrl+A selects every clip
 * in the song whenever the arrangement has focus, and Escape clears it.
 */
describe("EditorView Select all in the arrangement (#835)", () => {
  const BAR = 768;

  /** BD with clips in bars 1 to 3, a second track with clips in bars 1 and 2. */
  async function renderFiveClips(layout = [3, 2]) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const { project } = buildArrangementProject(
      layout.map((count) =>
        Array.from({ length: count }, (_, bar) => ({
          startTicks: bar * BAR,
          durationTicks: BAR,
        })),
      ),
    );
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    return project;
  }

  const announced = () => screen.getByTestId("arrangement-selection-live");

  /** Press a key on the window; returns whether its default was prevented. */
  function press(key: string, init: { ctrlKey?: boolean } = {}): boolean {
    let prevented = false;
    fireAndFlush(() => {
      prevented = !fireEvent.keyDown(window, { key, ...init });
    });
    return prevented;
  }
  const selectAll = () => press("a", { ctrlKey: true });

  /** A click on BD's row (the first) in the middle of `bar`. */
  async function clickBdBar(bar: number): Promise<void> {
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: (bar - 0.5) * BAR * INITIAL_PIXELS_PER_TICK,
        clientY: 22 + ROW_METRICS.trackHeightPx / 2,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireAndFlush(() => fireEvent(canvas, event));
    }
    await waitFor(() =>
      expect(announced()).toHaveTextContent(`Selected clip on BD, bar ${bar}`),
    );
  }

  it("selects every clip from one, and from none, without the page's text", async () => {
    const log = vi.spyOn(defaultAnalytics, "log");
    await renderFiveClips();
    await clickBdBar(1);

    expect(selectAll()).toBe(true);
    await waitFor(() => expect(announced()).toHaveTextContent("5 clips selected"));

    expect(press("Escape")).toBe(true);
    await waitFor(() => expect(announced()).toHaveTextContent("No selection"));

    expect(selectAll()).toBe(true);
    await waitFor(() => expect(announced()).toHaveTextContent("5 clips selected"));

    const uses = log.mock.calls.filter(
      ([name, params]) =>
        name === "shortcut_used" &&
        (params as { action_id?: string }).action_id === "edit.select_all",
    );
    expect(uses).toHaveLength(2);
  });

  it("deletes and cuts exactly what it selected, leaving the tracks", async () => {
    const project = await renderFiveClips();
    selectAll();
    press("Delete");
    await waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        expect(loaded.value.song.placements).toEqual([]);
        expect(loaded.value.song.tracks).toHaveLength(2);
      },
      { timeout: 3_000 },
    );
    press("z", { ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Redo / })).toBeEnabled(),
    );

    selectAll();
    press("x", { ctrlKey: true });
    await waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        expect(loaded.value.song.placements).toEqual([]);
      },
      { timeout: 3_000 },
    );
  });

  it("still takes Cmd/Ctrl+A from the browser in a song with no clips", async () => {
    await renderFiveClips([0]);
    expect(selectAll()).toBe(true);
    expect(announced()).toHaveTextContent("No selection");
  });

  it("leaves a text field's Cmd/Ctrl+A alone, and the clip selection with it", async () => {
    await renderFiveClips();
    await clickBdBar(2);
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    tempo.focus();
    let prevented = false;
    fireAndFlush(() => {
      prevented = !fireEvent.keyDown(tempo, { key: "a", ctrlKey: true });
    });
    expect(prevented).toBe(false);
    expect(announced()).toHaveTextContent("Selected clip on BD, bar 2");
  });

  it("lists Select all in the guide with nothing selected, and lets the guide take Escape first", async () => {
    await renderFiveClips();
    const openGuide = async () => {
      press("?");
      return screen.findByRole("dialog", { name: /keyboard/i });
    };
    const selectAllRow = (guide: HTMLElement) =>
      guide
        .querySelector('[data-action="edit.select_all"]')
        ?.getAttribute("data-available");
    expect(selectAllRow(await openGuide())).toBe("true");
    press("Escape");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /keyboard/i })).toBeNull(),
    );

    await clickBdBar(1);
    await openGuide();
    press("Escape");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /keyboard/i })).toBeNull(),
    );
    expect(announced()).toHaveTextContent("Selected clip on BD, bar 1");
  });
});

/**
 * Delete removes a track only when the user chose it through its header
 * (#960). A track that is merely the one a lane click, a clip click, Escape or
 * a deleted clip left selected keeps it: a slip must never take a whole track.
 */
describe("EditorView Delete and the selected track (#960)", () => {
  const BAR = 768;

  /** BD with clips in bars 1 to 3, Track 2 with clips in bars 1 and 2. */
  async function renderTwoTracks() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const { project } = buildArrangementProject([
      [0, 1, 2].map((bar) => ({ startTicks: bar * BAR, durationTicks: BAR })),
      [0, 1].map((bar) => ({ startTicks: bar * BAR, durationTicks: BAR })),
    ]);
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
  }

  const announced = () => screen.getByTestId("arrangement-selection-live");
  const press = (key: string) => fireAndFlush(() => fireEvent.keyDown(window, { key }));
  const header = (name: string) => screen.queryByRole("button", { name: `Edit ${name}` });

  /** A click on BD's row (the first) in the middle of `bar`. */
  function clickBdBar(bar: number): void {
    const canvas = document.querySelector(".arrangement-layer-interactive");
    if (!canvas) throw new Error("no arrangement interaction canvas rendered");
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: (bar - 0.5) * BAR * INITIAL_PIXELS_PER_TICK,
        clientY: 22 + ROW_METRICS.trackHeightPx / 2,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireAndFlush(() => fireEvent(canvas, event));
    }
  }

  it("keeps the track when a second Backspace follows a deleted clip", async () => {
    await renderTwoTracks();
    clickBdBar(1);
    press("Backspace");
    await waitFor(() => expect(announced()).toHaveTextContent("No selection"));
    press("Backspace");
    expect(header("BD")).toBeInTheDocument();
  });

  it("keeps the track after a missed clip click lands on empty lane", async () => {
    await renderTwoTracks();
    clickBdBar(1);
    clickBdBar(5);
    await waitFor(() => expect(announced()).toHaveTextContent("Position 5.1.1"));
    press("Delete");
    expect(header("BD")).toBeInTheDocument();
  });

  it("keeps the track after an empty-lane click on a fresh project", async () => {
    await renderTwoTracks();
    clickBdBar(5);
    press("Delete");
    expect(header("BD")).toBeInTheDocument();
  });

  it("keeps the track after Escape clears a clip selection", async () => {
    await renderTwoTracks();
    clickBdBar(1);
    press("Escape");
    await waitFor(() => expect(announced()).toHaveTextContent("No selection"));
    press("Delete");
    expect(header("BD")).toBeInTheDocument();
  });

  it("announces a track chosen by its header, and deletes it on Delete (#537)", async () => {
    await renderTwoTracks();
    await fireAndFlush(() => fireEvent.click(header("BD") as HTMLElement));
    await waitFor(() => expect(announced()).toHaveTextContent("Selected track BD"));
    expect(header("BD")?.closest(".track-header")).toHaveClass("chosen");
    press("Delete");
    expect(header("BD")).not.toBeInTheDocument();
    expect(header("Track 2")?.closest(".track-header")).not.toHaveClass("chosen");
    // The neighbour it falls to is shown, not chosen: a second Delete keeps it.
    press("Delete");
    expect(header("Track 2")).toBeInTheDocument();
  });

  it("drops the header's choice on a lane click or Escape", async () => {
    await renderTwoTracks();
    await fireAndFlush(() => fireEvent.click(header("BD") as HTMLElement));
    clickBdBar(5);
    expect(header("BD")?.closest(".track-header")).not.toHaveClass("chosen");
    press("Delete");
    expect(header("BD")).toBeInTheDocument();

    await fireAndFlush(() => fireEvent.click(header("BD") as HTMLElement));
    await waitFor(() => expect(announced()).toHaveTextContent("Selected track BD"));
    press("Escape");
    await waitFor(() => expect(announced()).toHaveTextContent("No selection"));
    press("Delete");
    expect(header("BD")).toBeInTheDocument();
  });
});
