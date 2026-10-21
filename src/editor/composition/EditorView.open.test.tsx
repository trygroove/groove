import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecordingTransport } from "../../analytics/transport";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import { detectCapabilities } from "../../browser/capabilities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { toTicks } from "../../domain/time";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { saveFailure } from "../../persistence/projectRepository";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import {
  createStepGridProject,
  goToView,
  leaveForArrangement,
  loadEditorView,
  openSequenceEditor,
  paintStep,
  recordingAnalytics,
  renderEditor,
  sampler,
  saveRetryButton,
  saveStatusGroup,
} from "./EditorView.testHarness";
import { focusedValueField } from "./valueFieldFocus";

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("../../audio/AudioRuntime");
let inMemoryModule: typeof import("../../persistence/inMemoryProjectRepository");
let documentsModule: typeof import("../../persistence/documents");

beforeAll(async () => {
  AudioRuntimeModule = await import("../../audio/AudioRuntime");
  inMemoryModule = await import("../../persistence/inMemoryProjectRepository");
  documentsModule = await import("../../persistence/documents");
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

describe("EditorView", () => {
  // #75: a browser missing something Groove needs still opens the project, and
  // says what is missing, what it costs and what to do.
  it("opens the project and explains each missing capability, reporting it once", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const transport = createRecordingTransport();
    const capabilities = detectCapabilities({
      AudioContext: class {
        decodeAudioData() {}
      },
      localStorage: memoryStorage(),
      indexedDB: {},
      URL: { createObjectURL: () => "" },
      HTMLAnchorElement: { prototype: { download: "" } },
      document: { createElement: () => ({ getContext: () => ({}) }) as never },
    });

    renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(transport),
      capabilities,
    });

    const notice = await screen.findByRole("region", { name: "Browser support" });
    expect(notice).toHaveTextContent("Export isn't available here.");
    expect(notice).toHaveTextContent(/Chrome, Edge or Firefox to export it/);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(
      transport.named("browser_capability_missing").map((event) => event.params),
    ).toEqual([
      expect.objectContaining({ capability: "offline_audio", is_required: false }),
    ]);

    clickAndFlush(
      within(notice).getByRole("button", {
        name: "Dismiss: Export isn't available here",
      }),
    );
    expect(screen.queryByRole("region", { name: "Browser support" })).toBeNull();
  });

  it("shows a loading state, then the 404 page for a project that does not exist", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();

    renderEditor("prj_doesnotexist00000000");

    expect(screen.getByText("Loading project")).toBeInTheDocument();
    expect(await screen.findByText("This groove is broken")).toBeInTheDocument();
  });

  it("names the tab after the open project", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    await vi.waitFor(() =>
      expect(document.title).toBe(`${project.metadata.name} – Groove`),
    );
  });

  it("loads a project and renders its step editor with the saved steps", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    const editor = await openSequenceEditor();
    expect(
      within(editor).getByRole("region", { name: "Step editor" }),
    ).toBeInTheDocument();
    // The four-on-the-floor clip: steps 1, 5, 9, 13 on the "BD" pad lane.
    expect(screen.getByRole("button", { name: "BD, step 1, on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BD, step 2, off" })).toBeInTheDocument();
    // The track's name is the editor's title, once: no second row repeats it
    // with the pack dependency beneath the title bar.
    expect(
      within(editor).getByRole("heading", { name: project.song.tracks[0].name }),
    ).toBeInTheDocument();
    expect(within(editor).queryByText(/^Pack:/)).not.toBeInTheDocument();

    // Undo starts disabled: nothing has been edited yet in this session.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("opens a project whose song places a clip that was never saved, and says so (#965)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    // What an interrupted save left behind: the song carries a duplicate's
    // placement, and the duplicate's clip document was never written.
    const [placement] = project.song.placements;
    const unsaved = {
      ...placement,
      id: `plc_${"u".repeat(21)}`,
      clipId: `clp_${"u".repeat(21)}`,
      startTicks: toTicks(placement.durationTicks),
    } as typeof placement;
    const stored = documentsModule.encodeSong(
      project.metadata.id,
      { ...project.song, placements: [placement, unsaved] },
      project.metadata.revision,
      project.metadata.modifiedAt,
    );
    repository.writeDocument(stored.song.path, stored.song.data);

    renderEditor(project.metadata.id);

    expect(
      await screen.findByText(/1 clip in the arrangement never saved and was left out/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();

    // The repaired song is written back, so the next open is clean.
    await waitFor(
      async () => {
        const reloaded = await repository.loadProject(project.metadata.id);
        expect(reloaded.ok && reloaded.dropped === undefined).toBe(true);
      },
      { timeout: 3_000 },
    );

    clickAndFlush(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/never saved/)).not.toBeInTheDocument();
  });

  it("renders the tempo-labelled loop panel for a project with an audio loop (LOOP-006)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    // The loop is on the fixture's second track, so it is that row's clip the
    // sequence editor has to be opened on. The loop panel distinguishes a
    // tempo-labelled loop from a pitched one-shot and documents the alpha's
    // time-stretch behaviour.
    const editor = await openSequenceEditor(1);
    expect(
      within(editor).getByRole("region", { name: "Audio loop" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/tempo-labelled loop/i)).toBeInTheDocument();
    expect(screen.getByText(/time-stretch/i)).toBeInTheDocument();
    expect(screen.getByText(/preserves pitch/i)).toBeInTheDocument();
  });

  it("renders the piano roll (not the step grid) for a synth track's note clip (CLP-03)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createPianoRollFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    const editor = await openSequenceEditor();
    expect(
      within(editor).getByRole("region", { name: /Piano roll/ }),
    ).toBeInTheDocument();
    // The step editor is a two-dimensional pitch editor's poor fit, so a
    // synth note clip shows the piano roll instead.
    expect(screen.queryByRole("region", { name: "Step editor" })).not.toBeInTheDocument();
  });

  it("renders the piano roll (not the step grid) for a sampler track's note clip (#496)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    // A sampler is a tonal instrument, so its clip opens the piano roll like a
    // synth's; only a drum machine keeps the step grid.
    const editor = await openSequenceEditor();
    expect(
      within(editor).getByRole("region", { name: /Piano roll/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Step editor" })).not.toBeInTheDocument();
  });

  // ARR-010: every key the redesigned roll answers goes through the registry,
  // pressed on the window as a person presses it, never on an element.
  it("moves, copies, pastes and deletes the roll's notes from the keyboard", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createPianoRollFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    const editor = await openSequenceEditor();
    const names = () =>
      within(within(editor).getByRole("listbox", { name: "Notes" }))
        .queryAllByRole("option")
        .map((option) => option.getAttribute("aria-label"));
    const press = (key: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
      fireAndFlush(() => fireEvent.keyDown(window, { key, ...init }));

    press("a", { ctrlKey: true });
    expect(within(editor).getByText("4 selected")).toBeInTheDocument();
    press("ArrowUp");
    press("ArrowRight");
    press("ArrowRight", { shiftKey: true });
    expect(names()[0]).toBe("C♯3, step 2, 2 steps");
    press("ArrowUp", { shiftKey: true });
    expect(names()[0]).toBe("C♯4, step 2, 2 steps");

    press("c", { ctrlKey: true });
    clickAndFlush(within(editor).getByRole("button", { name: "Step 20" }));
    press("v", { ctrlKey: true });
    expect(names()).toHaveLength(8);
    expect(names()).toContain("C♯4, step 20, 2 steps");
    expect(within(editor).getByText("4 selected")).toBeInTheDocument();

    press("a", { ctrlKey: true });
    press("Delete");
    expect(names()).toEqual([]);

    // Esc does not leave the roll: it is a view, not a dialog (UI-002). `1` does.
    press("Escape");
    expect(screen.getByRole("region", { name: "Sequence editor" })).toBeInTheDocument();
    await leaveForArrangement();
  });

  // ARR-010: a focused Transform value field takes ↑/↓ from the roll, through
  // the registry's `value_field` context. Leaving the view lets go of them.
  it("nudges a Transform value field from the keyboard, and lets go when the view goes", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createPianoRollFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id);
    const editor = await openSequenceEditor();
    const field = within(editor).getByLabelText("Semitones") as HTMLInputElement;
    const firstNote = () =>
      within(within(editor).getByRole("listbox", { name: "Notes" }))
        .getAllByRole("option")[0]
        .getAttribute("aria-label");
    const before = firstNote();
    const press = (key: string) =>
      fireAndFlush(() => fireEvent.keyDown(field, { key, bubbles: true }));

    fireAndFlush(() => field.focus());
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowDown");
    await Promise.resolve();
    expect(field.value).toBe("+13 st");
    // The arrows nudged the field, not the notes.
    expect(firstNote()).toBe(before);

    fireAndFlush(() => field.blur());
    clickAndFlush(within(editor).getByRole("button", { name: "Transpose" }));
    expect(firstNote()).not.toBe(before);

    fireAndFlush(() => field.focus());
    expect(focusedValueField()).not.toBeNull();
    // A digit typed into the field is the field's, not a view key.
    fireAndFlush(() => field.blur());
    await leaveForArrangement();
    // The unmounted field let go of the arrows, or they would still nudge it.
    expect(focusedValueField()).toBeNull();
  });

  it("shows the sampler instrument panel for the slice's sampler track", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();
    await goToView("Instrument");

    // Named for its track, because a drop has to land on a particular one.
    expect(
      await screen.findByRole("region", { name: "BD instrument" }),
    ).toBeInTheDocument();
    // The INS-01 sampler controls: pitch, sample start/end, amp envelope.
    expect(screen.getByLabelText("Pitch")).toBeInTheDocument();
    expect(screen.getByLabelText("Start")).toBeInTheDocument();
    expect(screen.getByLabelText("End")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audition" })).toBeInTheDocument();
    // It says what it is holding rather than offering a list of the project's
    // own samples to swap between (#225).
    const panel = screen.getByRole("region", { name: "BD instrument" });
    expect(within(sampler()).getByText("909 Bass Drum")).toBeInTheDocument();
    expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("EditorView", () => {
  it("toggling a step enables undo, and undo reverts it", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();

    paintStep("BD, step 2, off");
    expect(
      await screen.findByRole("button", { name: "BD, step 2, on" }),
    ).toBeInTheDocument();

    const undoButton = await screen.findByRole("button", { name: /^Undo/ });
    expect(undoButton).not.toBeDisabled();
    fireEvent.click(undoButton);

    expect(
      await screen.findByRole("button", { name: "BD, step 2, off" }),
    ).toBeInTheDocument();
  });

  // #844: every project change logged hundreds of Solid dev warnings, because
  // the effects that react to it read the project from their untracked apply
  // halves. Opening the project and editing it must log none.
  it("opens and edits a project without a STRICT_READ_UNTRACKED warning (#844)", async () => {
    const warn = vi.spyOn(console, "warn");
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();
    paintStep("BD, step 2, off");
    expect(
      await screen.findByRole("button", { name: "BD, step 2, on" }),
    ).toBeInTheDocument();
    flush();

    const strictReads = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("STRICT_READ_UNTRACKED"));
    expect(strictReads.length, strictReads[0]).toBe(0);
  });

  it("autosaves an edit, and the save status settles to Saved with an advanced revision", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const startingRevision = project.metadata.revision;

    renderEditor(project.metadata.id);
    await openSequenceEditor();

    paintStep("BD, step 2, off");

    const saveStatus = await screen.findByText("Saved", {}, { timeout: 3_000 });
    expect(
      Number(saveStatus.closest(".save-status")?.getAttribute("data-revision")),
    ).toBeGreaterThan(startingRevision);

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    expect(clip.content.events).toHaveLength(5);
  });

  it("the save status revision keeps advancing across undo, so a stale echo cannot restore the undone note", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();

    paintStep("BD, step 2, off");
    await screen.findByText("Saved", {}, { timeout: 3_000 });
    const saveStatusEl = document.querySelector(".save-status");
    const revisionAfterAdd = Number(saveStatusEl?.getAttribute("data-revision"));

    const undoButton = await screen.findByRole("button", { name: /^Undo/ });
    fireEvent.click(undoButton);
    await screen.findByRole("button", { name: "BD, step 2, off" });

    await vi.waitFor(() => {
      const revisionAfterUndo = Number(saveStatusEl?.getAttribute("data-revision"));
      expect(revisionAfterUndo).toBeGreaterThan(revisionAfterAdd);
    });

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    // The undone note stayed undone in the persisted document too.
    expect(clip.content.events).toHaveLength(4);
  });

  it("shows an actionable Save failed state with an explicit retry, and recovers", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    repository.failNextWrites({ count: 1 });
    renderEditor(project.metadata.id);
    await openSequenceEditor();

    paintStep("BD, step 2, off");

    await screen.findByText("Save failed", {}, { timeout: 3_000 });
    expect(
      within(saveStatusGroup()).getByText("Offline. Reconnect to save."),
    ).toBeInTheDocument();
    const retryButton = saveRetryButton();
    expect(retryButton).not.toBeNull();

    fireEvent.click(retryButton as HTMLElement);

    await screen.findByText("Saved", {}, { timeout: 3_000 });
    expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
    expect(saveRetryButton()).toBeNull();

    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    const clip = loaded.value.clips[0];
    if (clip.content.kind !== "notes") throw new Error("expected a note clip");
    expect(clip.content.events).toHaveLength(5);
  });

  it("replays its edit over a change another tab wrote first, and ends on Saved (GRV-88)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();

    // Another client's write lands in the store directly, without going
    // through `saveMetadata` (which would notify this session's own
    // `watchProject` listener before the edit below is written). That models
    // the real race the revision check exists for: the remote write reaches
    // the server before this tab's watcher has delivered word of it. The
    // write is refused as a conflict, and the session takes the saved project
    // in, replays the edit on top of it and writes it at the new revision.
    const path = documentsModule.projectDocumentPath(project.metadata.id);
    const stored = repository.readDocument(path);
    if (!stored) throw new Error("expected the metadata document to exist");
    repository.writeDocument(path, {
      ...stored,
      revision: (stored.revision as number) + 1,
    });

    paintStep("BD, step 2, off");

    await vi.waitFor(
      async () => {
        const loaded = await repository.loadProject(project.metadata.id);
        if (!loaded.ok) throw new Error("expected the project to load");
        const clip = loaded.value.clips[0];
        if (clip.content.kind !== "notes") throw new Error("expected a note clip");
        expect(clip.content.events).toHaveLength(5);
      },
      { timeout: 3_000 },
    );
    await screen.findByText("Saved", {}, { timeout: 3_000 });
    expect(
      screen.queryByText("This project changed in another tab or session."),
    ).not.toBeInTheDocument();
  });

  it("does not offer a retry button for a non-retryable failure", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await openSequenceEditor();

    vi.spyOn(repository, "saveChanges").mockResolvedValue(
      saveFailure("document_too_large", "too large"),
    );
    paintStep("BD, step 2, off");

    await screen.findByText("Save failed", {}, { timeout: 3_000 });
    expect(
      screen.getByText("This project is too large to save further changes."),
    ).toBeInTheDocument();
    expect(saveRetryButton()).toBeNull();
  });
});
