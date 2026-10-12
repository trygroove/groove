import { createRouter, memoryHistory, useLocation, useNavigate } from "@solidjs/router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analytics as defaultAnalytics } from "../analytics";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { INITIAL_PIXELS_PER_TICK, ROW_METRICS } from "../arrangement/ArrangementView";
import type { AssistantClient } from "../assistant/assistantClient";
import { RECOMMEND_SOUNDS_TOOL } from "../assistant/recommendation";
import type { AssistantRetentionClient } from "../assistant/retentionClient";
import { ASSISTANT_TOOLSET_VERSION } from "../assistant/tools";
import { installWebAudioGlobals } from "../audio/testAudioContext";
import { type CapabilityReport, detectCapabilities } from "../browser/capabilities";
import { executeTransaction } from "../commands";
import { type Project, packVersion } from "../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createFactoryContext,
} from "../domain/factories";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import type { PackId } from "../domain/ids";
import { toTicks } from "../domain/time";
import { fakePreviewEngine } from "../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher, fixturePackManifest } from "../library/__fixtures__/fixtures";
import { LIBRARY_SAMPLE_MIME } from "../library/assetDrag";
import type { PreviewEngine } from "../library/audition";
import { loadPadSampleCommands, toLibrarySample } from "../library/insertion";
import { LibraryClient } from "../library/libraryClient";
import {
  type LibraryAsset,
  PACK_INDEX_PATH,
  packAssets,
  parsePackManifest,
} from "../library/manifest";
import type { InMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { saveFailure } from "../persistence/projectRepository";
import { systemClock } from "../shared/clock";
import { detectPlatform, shortcutLabel } from "../shortcuts";
import { buildArrangementProject } from "../testing/arrangementProject";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import {
  createFakeAssistantClient,
  type FakeAssistantClient,
} from "../testing/fakeAssistantClient";
import { createFakeRetentionClient } from "../testing/fakeRetentionClient";
import { memoryStorage } from "../testing/storage";
import { packAudioPath } from "../userData/userData";
import { createInMemoryUserLibraryRepository } from "../userLibrary/inMemoryUserLibraryRepository";
import { deleteUserSound } from "../userLibrary/packOperations";
import type { UserLibraryRepository } from "../userLibrary/userLibraryRepository";
import {
  addSound,
  type NewUserPackAsset,
  newUserPack,
  userPackAssets,
} from "../userLibrary/userPacks";
import type { UserLibraryAccount } from "../userLibrary/useUserLibrary";
import { LAYOUT_STORAGE_KEY } from "./assistant/assistantPanelLayout";
import { editorViewFromPath, editorViewPath } from "./editorViews";
import { createStarterProject } from "./starterProject";
import { NEW_TRACK_KINDS } from "./trackCreation";
import { focusedValueField } from "./valueFieldFocus";

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("../audio/AudioRuntime");
let inMemoryModule: typeof import("../persistence/inMemoryProjectRepository");
let documentsModule: typeof import("../persistence/documents");
let EditorViewModule: typeof import("./EditorView");

beforeAll(async () => {
  AudioRuntimeModule = await import("../audio/AudioRuntime");
  inMemoryModule = await import("../persistence/inMemoryProjectRepository");
  documentsModule = await import("../persistence/documents");
  EditorViewModule = await import("./EditorView");
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

vi.mock("../projectRepositoryClient", () => ({
  getProjectRepository: () => Promise.resolve(repository),
}));

/**
 * The slice fixture as a drum machine: one "BD" pad on the kick sample, the
 * four-on-the-floor clip re-pointed at that pad. A sampler note clip opens the
 * piano roll (#496), so the step grid is only reachable through a drum machine.
 */
function createStepGridProject(): Project {
  const project = createSliceFixtureProject();
  const [track] = project.song.tracks;
  const [asset] = project.song.assets;
  const pad = createDrumPad(createFactoryContext(), { name: "BD", assetId: asset.id });
  return {
    ...project,
    song: {
      ...project.song,
      tracks: [{ ...track, instrument: createDrumMachineInstrument([pad]) }],
    },
    clips: project.clips.map((clip) =>
      clip.content.kind === "notes"
        ? {
            ...clip,
            content: {
              ...clip.content,
              events: clip.content.events.map((event) => ({
                ...event,
                trigger: { kind: "pad" as const, padId: pad.id },
              })),
            },
          }
        : clip,
    ),
  };
}

/**
 * Paints or erases one step-editor cell the way a pointer does: `pointerdown`
 * begins the stroke (add if the cell is empty, erase if filled), `pointerup`
 * commits it as one history entry. `fireEvent.click` is not enough — the step
 * editor drives painting from pointer events, not click, so a drag never starts
 * a text selection (CLP-02).
 */
function paintStep(name: string): void {
  const cell = screen.getByRole("button", { name });
  fireEvent.pointerDown(cell, { button: 0 });
  fireEvent.pointerUp(cell);
}

/**
 * The header's save-status group. Save-failure assertions are scoped to it
 * rather than queried across the document: the library panel is open from the
 * first paint (#221) and reports its own failed load — with the same "Check
 * your connection." wording and its own Retry button — whenever its manifest
 * fetch fails, which it always does under jsdom.
 */
function saveStatusGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>(".save-status-group");
  if (!group) throw new Error("expected the header's save-status group");
  return group;
}

/**
 * The mixer's "edit this track" control for one strip. Scoped to the mixer:
 * the arrangement's header column offers the identically named control for the
 * same track, which is the point — either surface selects it.
 */
function mixerSelect(trackName: string): HTMLElement {
  return within(screen.getByRole("region", { name: "Mixer" })).getByRole("button", {
    name: `Edit ${trackName}`,
  });
}

/**
 * Opens the clip at bar 1 of the first arrangement row the way a producer does
 * — a double-click on the timeline (`UI-001`) — and waits for the sequence
 * editor it brings up. The coordinates mirror the renderer's own constants,
 * because a canvas has no DOM node to query for a hit.
 */
async function openSequenceEditor(rowIndex = 0): Promise<HTMLElement> {
  await screen.findByTestId("arrangement-view-ready");
  const canvas = document.querySelector(".arrangement-layer-interactive");
  if (!canvas) throw new Error("no arrangement interaction canvas rendered");
  const PIXELS_PER_TICK = 0.08;
  const RULER_HEIGHT_PX = 22;
  // The arrangement's own row height, so aiming at row N keeps hitting row N
  // when the rows change size.
  const ROW_HEIGHT_PX = ROW_METRICS.trackHeightPx;
  const TICKS_PER_BAR = 768;
  fireAndFlush(() =>
    fireEvent.dblClick(canvas, {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX * (rowIndex + 0.5),
    }),
  );
  return screen.findByRole("region", { name: "Sequence editor" });
}

/**
 * Presses `1`: from the sequence view back to the arrangement (`UI-002`), which
 * is what closing the old sequence modal became. Escape does not do it: a view
 * is not a dialog.
 */
async function leaveForArrangement(): Promise<void> {
  fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
  await screen.findByTestId("arrangement-view-ready");
  expect(screen.queryByRole("region", { name: "Sequence editor" })).toBeNull();
}

/**
 * Moves to a view through the dock, the way a person does (`UI-001`): the
 * editor shows exactly one, so a test wanting another has to go there.
 */
async function goToView(label: "Arrangement" | "Instrument" | "Mixer"): Promise<void> {
  // The dock exists only once the project is open, so this is also the wait.
  const dock = await screen.findByRole("navigation", { name: "Views" });
  clickAndFlush(within(dock).getByRole("link", { name: label }));
  await vi.waitFor(() =>
    expect(dock.querySelector("[aria-current='page']")).toHaveAccessibleName(label),
  );
}

/** Null when the save state offers no retry: non-retryable, or not failed. */
function saveRetryButton(): HTMLElement | null {
  return within(saveStatusGroup()).queryByRole("button", { name: "Retry" });
}

// EditorView links back to the dashboard with a plain anchor, which the router
// only resolves from inside a matched route — so the editor is mounted over an
// in-memory history, which is Router 2's replacement for the old
// `<MemoryRouter><Route .../></MemoryRouter>` pair.
//
// The router carries the same three project paths the real table does
// (`src/router.tsx`) and derives the view from the address exactly as
// `routes/projects/Project.tsx` does, because the view *is* the address
// (`UI-001`): a harness that passed a view prop directly could not tell a
// working dock from one that navigates nowhere.
function renderEditor(
  projectId: string,
  options: {
    createAuditionEngine?: () => PreviewEngine;
    libraryClient?: LibraryClient;
    analytics?: Analytics;
    capabilities?: CapabilityReport;
    account?: UserLibraryAccount | null;
    userLibraryRepository?: () => Promise<UserLibraryRepository>;
    assistantClient?: () => Promise<AssistantClient>;
    assistantRetentionClient?: () => Promise<AssistantRetentionClient>;
  } = {},
) {
  // Unless a test is about the disclosure, the account has already answered it.
  const retentionClient = createFakeRetentionClient({ answered: true });
  const EditorView = EditorViewModule.default;
  const location = memoryHistory(editorViewPath(projectId, "arrangement"));
  const Page = () => {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <EditorView
        projectId={projectId}
        view={editorViewFromPath(location.pathname)}
        viewHref={(view) => editorViewPath(projectId, view)}
        onSelectView={(view) => navigate(editorViewPath(projectId, view))}
        createAuditionEngine={options.createAuditionEngine}
        libraryClient={options.libraryClient}
        analytics={options.analytics}
        capabilities={options.capabilities}
        libraryAccount={options.account}
        userLibraryRepository={options.userLibraryRepository}
        assistantClient={options.assistantClient}
        assistantRetentionClient={
          options.assistantRetentionClient ?? (async () => retentionClient)
        }
      />
    );
  };
  const TestRouter = createRouter({
    history: location,
    // The real table's shape (`src/router.tsx`): one route, not one per view,
    // so a switch does not remount the editor.
    routes: [{ path: "/projects/:id/:view?", component: Page }],
  });
  return { ...render(() => <TestRouter />), location };
}

/** A library sound as a drag hands it over, already in its wire form (#225). */
const DROPPED_HAT = {
  name: "Dropped Closed Hat",
  packId: "pak_SdlN_OazweXrwury0j27Y",
  packVersion: "1.0.0",
  kind: "sample",
  storageRef: "samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  url: "/samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  durationSeconds: 0.25,
  sampleRate: 48000,
  channelCount: 1,
  licence: "solid-groove-owned",
};

/** jsdom implements no `DataTransfer`; this is the slice a drop reads. */
function transferCarrying(sample: unknown) {
  const payload = JSON.stringify(sample);
  return {
    types: [LIBRARY_SAMPLE_MIME],
    getData: (format: string) => (format === LIBRARY_SAMPLE_MIME ? payload : ""),
    setData: () => {},
  };
}

/**
 * The name of the first loop in a committed fixture pack.
 *
 * Read from the manifest rather than written down, so a test that needs "a
 * loop" keeps pointing at one when the delivered library changes underneath
 * it — the same reason CF-005 finds its loop by reading the rows.
 */
function loopAssetName(slug: string): string {
  return assetNameOfType(slug, "loop");
}

/** The name of the first insertable one-shot in a committed fixture pack. */
function oneShotAssetName(slug: string): string {
  return assetNameOfType(slug, "one-shot");
}

/** The insertable one-shots of the committed Core Electronic Drums fixture. */
function drumOneShots(): LibraryAsset[] {
  const manifest = parsePackManifest(fixturePackManifest("core-electronic-drums"));
  return packAssets(manifest).filter((asset) => asset.type === "one-shot" && asset.url);
}

function assetNameOfType(slug: string, type: "loop" | "one-shot"): string {
  const manifest = parsePackManifest(fixturePackManifest(slug));
  const found = packAssets(manifest).find((asset) => asset.type === type && asset.url);
  if (!found) throw new Error(`fixture pack "${slug}" ships no ${type}`);
  return found.name;
}

function recordingAnalytics(
  transport: ReturnType<typeof createRecordingTransport>,
  consent: ConsentStore = new ConsentStore(memoryStorage()),
): Analytics {
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  return analytics;
}

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

  it("loads a sound dropped from the library onto the sampler, undoably", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const transport = createRecordingTransport();

    renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(transport),
    });
    await openSequenceEditor();
    await goToView("Instrument");
    const panel = await screen.findByRole("region", {
      name: "BD instrument",
    });

    fireEvent.drop(panel, { dataTransfer: transferCarrying(DROPPED_HAT) });

    // The sampler names the dropped sound, and the project now carries it.
    expect(await within(sampler()).findByText(DROPPED_HAT.name)).toBeInTheDocument();
    const changed = transport.named("instrument_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].params.instrument_type).toBe("sampler");

    // Carrying the asset and pointing the sampler at it is one transaction, so
    // one undo takes the whole drop back.
    fireEvent.click(await screen.findByRole("button", { name: /^Undo/ }));
    expect(await within(sampler()).findByText("909 Bass Drum")).toBeInTheDocument();
  });

  it("inserts from the keyboard onto the same track a drop would reach", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    const transport = createRecordingTransport();
    renderEditor(project.metadata.id, {
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });
    const tracksBefore = project.song.tracks.length;

    await openLibrary();
    // A one-shot specifically: the same Insert control takes a loop to a new
    // track instead (#281), which is what this test must tell apart.
    const name = oneShotAssetName("core-electronic-drums");
    await insertSound(name);

    // The Insert button inserts and goes back, as Enter does (UI-002).
    await backFromInsert();
    await screen.findByRole("region", { name: "BD instrument" });
    expect(await within(sampler()).findByText(name)).toBeInTheDocument();

    // The one-shot path creates no track — the loop path's outcome is not
    // this one's (#281). Merging the two would fail here.
    expect(transport.named("track_added")).toHaveLength(0);
    expect(transport.named("instrument_changed")).toHaveLength(1);
    await goToView("Arrangement");
    expect(
      within(screen.getByLabelText("Arrangement tracks")).getAllByRole("listitem"),
    ).toHaveLength(tracksBefore);
  });

  it("walks the library with the arrow keys and inserts with Enter", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const engine = fakePreviewEngine();
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => engine,
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    const library = await openLibrary();
    await within(library).findByRole("list", { name: "Sounds" });

    // `library.select_next` is a registry key, live only in the library context.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "ArrowDown" }));
    await vi.waitFor(() => expect(engine.starts).toHaveLength(1));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Enter" }));

    // One insert, one history entry, and back to the instrument (UI-002).
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /^Undo / })).toBeEnabled(),
    );
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull();
  });

  it("loads a library one-shot onto the drum pad whose slot opened it (#447)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const [drums] = project.song.tracks;
    if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = drums.instrument.pads;
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const transport = createRecordingTransport();
    renderEditor(project.metadata.id, {
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });

    await goToView("Instrument");
    clickAndFlush(await screen.findByRole("button", { name: `Audition ${second.name}` }));
    clickAndFlush(screen.getByRole("button", { name: `Sample for ${second.name}` }));
    await screen.findByRole("region", { name: "Library" });
    const oneShotName = oneShotAssetName("core-electronic-drums");
    await insertSound(oneShotName);

    // The Insert button inserts and goes back, as Enter does (UI-002).
    await backFromInsert();
    // The chosen pad plays it; the first pad keeps its own sound.
    expect(slotSound(`Sample for ${second.name}`)).toBe(oneShotName);
    clickAndFlush(screen.getByRole("button", { name: `Audition ${first.name}` }));
    expect(slotSound(`Sample for ${first.name}`)).not.toBe(oneShotName);
    const changed = transport.named("instrument_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].params.instrument_type).toBe("drum_machine");
  });

  describe("into a project pinned to an older pack version (#892)", () => {
    /**
     * The drum-machine fixture with its first pad playing a Core Electronic
     * Drums sound pinned at 1.0.0, as a project made before the factory packs
     * moved to 1.1.0 does. `gone` gives that sound content the newer manifest
     * does not deliver.
     */
    async function seedOlderPinnedProject(gone: boolean) {
      const [kept, inserted] = drumOneShots();
      const keptSample = toLibrarySample(kept);
      if (!keptSample) throw new Error("expected an insertable sample");
      const fixture = createDrumMachineFixtureProject();
      const [drums] = fixture.song.tracks;
      if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
      const [first, second] = drums.instrument.pads;
      const seeded = executeTransaction(
        fixture,
        loadPadSampleCommands(
          fixture,
          drums.id,
          first.id,
          {
            ...keptSample,
            packVersion: packVersion("1.0.0"),
            storageRef: gone
              ? "samples/starter-library/audio/sha256/00/00/gone.wav"
              : keptSample.storageRef,
          },
          createFactoryContext(),
        ),
      );
      if (!seeded.ok) throw new Error(seeded.issues[0].message);
      repository = inMemoryModule.createInMemoryProjectRepository();
      const created = await repository.createProject(seeded.project);
      if (!created.ok) throw new Error("fixture project failed to create");
      const transport = createRecordingTransport();
      renderEditor(seeded.project.metadata.id, {
        createAuditionEngine: () => fakePreviewEngine(),
        libraryClient: new LibraryClient(fixtureFetcher()),
        analytics: recordingAnalytics(transport),
      });
      await goToView("Instrument");
      clickAndFlush(
        await screen.findByRole("button", { name: `Audition ${second.name}` }),
      );
      clickAndFlush(screen.getByRole("button", { name: `Sample for ${second.name}` }));
      await screen.findByRole("region", { name: "Library" });
      return { transport, second, inserted };
    }

    const closed = () =>
      vi.waitFor(() =>
        expect(screen.queryByRole("region", { name: "Library" })).not.toBeInTheDocument(),
      );

    it("upgrades the pin without asking when every sound is still in the pack, and one undo takes both back", async () => {
      const { transport, second, inserted } = await seedOlderPinnedProject(false);

      await insertSound(inserted.name);

      await closed();
      expect(slotSound(`Sample for ${second.name}`)).toBe(inserted.name);
      const upgraded = transport.named("library_pack_upgraded");
      expect(upgraded).toHaveLength(1);
      expect(upgraded[0].params).toMatchObject({
        choice: "automatic",
        missing_sound_count: 0,
      });
      expect(
        transport
          .named("feature_first_use")
          .filter((event) => event.params.feature === "pack_upgrade"),
      ).toHaveLength(1);

      fireEvent.click(await screen.findByRole("button", { name: /^Undo/ }));
      await vi.waitFor(() =>
        expect(slotSound(`Sample for ${second.name}`)).not.toBe(inserted.name),
      );
    });

    it("asks in the footer when sounds would go missing; Cancel changes nothing, Upgrade anyway inserts", async () => {
      const { transport, second, inserted } = await seedOlderPinnedProject(true);

      await insertSound(inserted.name);

      const library = screen.getByRole("region", { name: "Library" });
      expect(
        await within(library).findByText(
          /moves the project to Core Electronic Drums \S+, which leaves 1 sound in this project missing\./,
        ),
      ).toBeVisible();
      clickAndFlush(within(library).getByRole("button", { name: "Cancel" }));
      expect(within(library).getByText(/^Couldn't insert /)).toBeVisible();
      expect(
        within(library).getByRole("group", { name: "In the slot" }),
      ).not.toHaveTextContent(inserted.name);
      expect(transport.named("library_pack_upgraded")).toHaveLength(0);

      clickAndFlush(within(library).getByRole("button", { name: "Upgrade anyway" }));

      await closed();
      expect(slotSound(`Sample for ${second.name}`)).toBe(inserted.name);
      const upgraded = transport.named("library_pack_upgraded");
      expect(upgraded).toHaveLength(1);
      expect(upgraded[0].params).toMatchObject({
        choice: "upgrade_anyway",
        missing_sound_count: 1,
      });
    });
  });

  it("replaces a loop track's loop from its loop slot, without adding a track", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const [, breakTrack] = project.song.tracks;
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const transport = createRecordingTransport();
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });

    await goToView("Mixer");
    clickAndFlush(mixerSelect(breakTrack.name));
    await goToView("Instrument");
    clickAndFlush(
      await screen.findByRole("button", { name: `Loop for ${breakTrack.name}` }),
    );
    const library = await screen.findByRole("region", { name: "Library" });
    expect(within(library).getByRole("heading", { name: "Loops" })).toBeVisible();
    const loopName = loopAssetName("core-electronic-drums");
    await insertSound(loopName);

    // The Insert button inserts and goes back, as Enter does (UI-002).
    await backFromInsert();
    // The same track now plays the new loop, and no track was added.
    expect(slotSound(`Loop for ${breakTrack.name}`)).toBe(loopName);
    expect(transport.named("track_added")).toHaveLength(0);
    await goToView("Mixer");
    expect(mixerSelect(breakTrack.name)).toBeInTheDocument();
  });

  it("hears a library sound in the pad's slot without a command, and leaving puts it back (LIB-010)", async () => {
    const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
    const reconcile = vi.spyOn(ProjectAudioGraph.prototype, "reconcile");
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const [drums] = project.song.tracks;
    if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const pad = drums.instrument.pads[1];
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      libraryClient: new LibraryClient(fixtureFetcher()),
      createAuditionEngine: fakePreviewEngine,
    });
    /** The asset the pad plays in the graph's latest projection. */
    const heardOnPad = () => {
      const projection = reconcile.mock.lastCall?.[0];
      const instrument = projection?.tracksById.get(drums.id)?.instrument;
      if (instrument?.kind !== "drumMachine") return undefined;
      return instrument.pads.find((entry) => entry.id === pad.id)?.assetId;
    };

    await goToView("Instrument");
    await vi.waitFor(() => expect(heardOnPad()).toBe(pad.assetId));
    clickAndFlush(await screen.findByRole("button", { name: `Audition ${pad.name}` }));
    clickAndFlush(screen.getByRole("button", { name: `Sample for ${pad.name}` }));
    await screen.findByRole("region", { name: "Library" });
    const name = oneShotAssetName("core-electronic-drums");
    fireEvent.input(await screen.findByRole("searchbox", { name: "Search sounds" }), {
      target: { value: name },
    });
    fireEvent.click(await screen.findByRole("button", { name: `Audition ${name}` }));

    await vi.waitFor(() => expect(heardOnPad()).toMatch(/^ast_preview/));
    await leaveLibrary();
    expect(heardOnPad()).toBe(pad.assetId);
    // Audio only: no history entry, no revision, nothing saved.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(
      Number(document.querySelector(".save-status")?.getAttribute("data-revision")),
    ).toBe(project.metadata.revision);
    const stored = await repository.loadProject(project.metadata.id);
    expect(stored.ok && stored.value.metadata.revision).toBe(project.metadata.revision);
  });

  it("shows a track's instrument panel even before it has a clip (#228)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    // A track added from the mixer arrives with an instrument and no clip.
    // Its controls are the reason to select it, so the editor must not wait
    // for a clip before showing them.
    const fixture = createPianoRollFixtureProject();
    const project = {
      ...fixture,
      clips: [],
      song: { ...fixture.song, placements: [] },
    };
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");

    // A track with no clip has nothing to open (UI-001): neither clip editor
    // is anywhere on the page, and nothing is open over the arrangement.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Step editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Piano roll/ })).not.toBeInTheDocument();

    // The instrument is still there to reach, which is the point (#228).
    await goToView("Instrument");
    expect(
      await screen.findByRole("region", { name: "Synth voice" }),
    ).toBeInTheDocument();
  });

  it("switches the editor to a track selected in the mixer (#228)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    // The drum fixture's two tracks: a drum machine, then an audio track.
    const project = createDrumMachineFixtureProject();
    const [drums, breakTrack] = project.song.tracks;
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);

    // It opens on the first track: the instrument view shows its pads.
    await goToView("Instrument");
    expect(
      await screen.findByRole("region", {
        name: `Drum machine: ${drums.name}`,
      }),
    ).toBeInTheDocument();

    // Selection is one piece of state across all three views (UI-001), so a
    // track chosen in the mixer is the one the instrument view shows.
    await goToView("Mixer");
    fireEvent.click(mixerSelect(breakTrack.name));
    // Solid 2 publishes a write on the next microtask, and
    // `@solidjs/testing-library` 1.x re-exports `@testing-library/dom`'s raw
    // `fireEvent`, so nothing flushes it for us. Without this the assertions
    // below read the selection as it was before the click.
    flush();

    await goToView("Instrument");
    expect(
      screen.queryByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: `${breakTrack.name} loop` }),
    ).toBeInTheDocument();

    // And back, from the same control on the other strip.
    await goToView("Mixer");
    clickAndFlush(mixerSelect(drums.name));
    await goToView("Instrument");
    expect(
      screen.getByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).toBeInTheDocument();
  });

  it("switches the editor to a track selected in the arrangement (#228)", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const [drums, breakTrack] = project.song.tracks;
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");

    renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");

    // The arrangement's track header column: the same click a pointer makes
    // on a row, from the DOM side of the hybrid surface.
    clickAndFlush(
      within(screen.getByLabelText("Tracks")).getByRole("button", {
        name: `Edit ${breakTrack.name}`,
      }),
    );

    // Every view agrees on which track is selected (UI-001): the instrument
    // view has left the drum machine, and the mixer marks the new strip.
    await goToView("Instrument");
    expect(
      screen.queryByRole("region", { name: `Drum machine: ${drums.name}` }),
    ).not.toBeInTheDocument();
    await goToView("Mixer");
    expect(mixerSelect(breakTrack.name)).toHaveAttribute("aria-pressed", "true");
  });

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
      within(saveStatusGroup()).getByText("Check your connection."),
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

/** The Library, a view reached from a slot (`UI-001`, `UI-002`). */
describe("EditorView library view", () => {
  async function renderSlice() {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
  }

  it("is not on the page until a slot asks for it", async () => {
    await renderSlice();
    await screen.findByTestId("arrangement-view-ready");

    // The arrangement is full bleed: the column that used to live beside it
    // is gone, and so is the header toggle that opened and closed it.
    expect(screen.queryByRole("region", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();
  });

  it("opens from the sampler's sample slot, and a view key leaves it", async () => {
    await renderSlice();

    const library = await openLibrary();
    // A view at its own address, not a window over one (UI-002).
    expect(library).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(library).getByRole("region", { name: "Browse sounds" })).toBeVisible();

    // A view, not a dialog: Escape leaves it where it is (UI-002).
    fireAndFlush(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
    await leaveLibrary();
  });
});

/** The Library's target, shown on the slots (`UI-002`, CF-030). */
describe("EditorView library target", () => {
  it("marks the selected pad's slot with the 4 key, and follows the pad", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    const [drums] = project.song.tracks;
    if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = drums.instrument.pads;
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    renderEditor(project.metadata.id, { createAuditionEngine: fakePreviewEngine });
    await goToView("Instrument");

    const slot = await screen.findByRole("button", { name: `Sample for ${first.name}` });
    expect(slot).toHaveAttribute("aria-current", "true");
    expect(slot).toHaveTextContent("4");
    expect(slot).toHaveAttribute("aria-keyshortcuts", "4");
    clickAndFlush(screen.getByRole("button", { name: `Audition ${second.name}` }));
    expect(
      screen.getByRole("button", { name: `Sample for ${second.name}` }),
    ).toHaveAttribute("aria-current", "true");

    // Away and back by key: still aimed at the pad last touched.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "1" }));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    const header = await screen.findByRole("heading", { name: /^Inserting into / });
    expect(header).toHaveTextContent(`${drums.name} › Drum machine › ${second.name}`);
  });
});

/** What the dock's tiles say of the selection (`UI-002`, CF-008). */
describe("EditorView dock tips", () => {
  it("dims Sequence until a clip is open, names it, and dots a Library target", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStepGridProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    renderEditor(project.metadata.id);
    const tile = async (name: string) =>
      within(await screen.findByRole("navigation", { name: "Views" })).getByRole("link", {
        name,
      });
    const tipOf = async (name: string) => {
      const link = await tile(name);
      fireAndFlush(() => fireEvent.pointerEnter(link));
      return screen.getByRole("tooltip").textContent;
    };
    expect(await tile("Sequence")).toHaveClass("view-dock-dimmed");
    expect(await tipOf("Sequence")).toBe("2 Sequence");
    const track = project.song.tracks[0];
    expect(await tipOf("Library")).toBe(`4 Library · sounds for ${track.name}`);
    expect((await tile("Library")).querySelector(".view-dock-dot")).not.toBeNull();

    await openSequenceEditor();
    expect(await tile("Sequence")).not.toHaveClass("view-dock-dimmed");
    expect(await tipOf("Sequence")).toBe(`2 Sequence · ${project.clips[0].name}`);
  });
});

/** Inserting from the Library by key (`UI-002`, CF-030). */
describe("EditorView library insert keys", () => {
  it("stays on Shift+Enter, one undo per insert, and goes back on Enter", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const { location } = renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    const slot = () => screen.getByRole("group", { name: "In the slot" });
    const library = await openLibraryFromPad();
    const sounds = await within(library).findByRole("list", { name: "Sounds" });
    const [first, second] = within(sounds)
      .getAllByRole("button", { name: /^Audition / })
      .map(
        (button) => button.getAttribute("aria-label")?.replace(/^Audition /, "") ?? "",
      );

    const insertByKey = async (name: string, shiftKey = true) => {
      clickAndFlush(within(sounds).getByRole("button", { name: `Audition ${name}` }));
      await vi.waitFor(() =>
        expect(screen.getByRole("group", { name: "Hearing" })).toHaveTextContent(name),
      );
      fireAndFlush(() => fireEvent.keyDown(window, { key: "Enter", shiftKey }));
    };
    await insertByKey(first);
    await vi.waitFor(() => expect(slot()).toHaveTextContent(first));
    // Staying, an insert shows it went in: the readout lights, and says so.
    expect(slot()).toHaveClass("library-modal-readout-inserted");
    expect(within(library).getByRole("status")).toHaveTextContent(`Inserted ${first}`);
    await insertByKey(second);
    await vi.waitFor(() => expect(slot()).toHaveTextContent(second));
    expect(location.get()).toMatch(/\/library$/);

    // Each insert was its own history entry: one undo takes back only the second.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "z", ctrlKey: true }));
    await vi.waitFor(() => expect(slot()).toHaveTextContent(first));

    await insertByKey(second, false);
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
  });

  it("goes back to the instrument on Enter, from wherever 4 was pressed", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const { location } = renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    await screen.findByTestId("arrangement-view-ready");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    const library = await screen.findByRole("region", { name: "Library" });
    const sounds = await within(library).findByRole("list", { name: "Sounds" });
    clickAndFlush(within(sounds).getAllByRole("button", { name: /^Audition / })[1]);

    fireAndFlush(() => fireEvent.keyDown(window, { key: "Enter" }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
  });

  it("goes back to the instrument from the Insert button, logged as library_insert", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const transport = createRecordingTransport();
    const { location } = renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
      analytics: recordingAnalytics(transport),
    });
    const library = await openLibraryFromPad();
    const sounds = await within(library).findByRole("list", { name: "Sounds" });
    const audition = within(sounds).getAllByRole("button", { name: /^Audition / })[1];
    const name = audition.getAttribute("aria-label")?.replace(/^Audition /, "") ?? "";
    clickAndFlush(audition);

    clickAndFlush(await screen.findByRole("button", { name: `Insert ${name}` }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
    expect(transport.named("view_changed").at(-1)?.params).toEqual(
      expect.objectContaining({ view: "instrument", via: "library_insert" }),
    );
  });

  it("leaves Enter to any other focused control, with a sound selected", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createDrumMachineFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const { location } = renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
    });
    const slot = () => screen.getByRole("group", { name: "In the slot" });
    const library = await openLibraryFromPad();
    const sounds = await within(library).findByRole("list", { name: "Sounds" });
    const before = slot().textContent;
    const audition = within(sounds).getAllByRole("button", { name: /^Audition / })[1];
    clickAndFlush(audition);
    const name = audition.getAttribute("aria-label")?.replace(/^Audition /, "") ?? "";
    await vi.waitFor(() =>
      expect(screen.getByRole("group", { name: "Hearing" })).toHaveTextContent(name),
    );

    // A rail button keeps its Enter: the browser presses it, nothing goes in.
    const rail = within(library).getByRole("button", { name: /^Browse packs/ });
    rail.focus();
    for (const shiftKey of [false, true]) {
      const pressed = fireEvent.keyDown(rail, { key: "Enter", shiftKey });
      expect(pressed).toBe(true); // not prevented: the default still runs
    }
    expect(slot().textContent).toBe(before);
    expect(location.get()).toMatch(/\/library$/);

    // The sound row's own button is the Library's: Enter inserts from there.
    audition.focus();
    expect(fireEvent.keyDown(audition, { key: "Enter" })).toBe(false);
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
  });
});

/** The Library at its own address, on `4` (`UI-002`). */
describe("EditorView library address", () => {
  async function renderOn(project: Project) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const rendered = renderEditor(project.metadata.id);
    await screen.findByTestId("arrangement-view-ready");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    return rendered;
  }

  it("says a synth plays no samples, with the way to a track that does", async () => {
    const { location } = await renderOn(createPianoRollFixtureProject());
    const empty = await screen.findByRole("region", {
      name: "Synths don't play samples",
    });
    expect(empty).toHaveTextContent(
      "The Library holds samples and loops. Select a sampler or drum machine track to browse sounds for it.",
    );
    expect(within(empty).getByRole("button", { name: "Arrangement" })).toHaveTextContent(
      "1",
    );
    clickAndFlush(within(empty).getByRole("button", { name: "Instrument" }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
  });

  it("logs the empty screen's way out once, as reached from the empty screen", async () => {
    const transport = createRecordingTransport();
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createPianoRollFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const { location } = renderEditor(project.metadata.id, {
      analytics: recordingAnalytics(transport),
    });
    await screen.findByTestId("arrangement-view-ready");
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    const empty = await screen.findByRole("region", {
      name: "Synths don't play samples",
    });
    clickAndFlush(within(empty).getByRole("button", { name: "Instrument" }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));

    expect(transport.named("view_changed").map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "library", via: "keyboard" }),
      expect.objectContaining({ view: "instrument", via: "empty_screen" }),
    ]);
  });

  it("says no track is selected in a song with none", async () => {
    const fixture = createSliceFixtureProject();
    await renderOn({
      ...fixture,
      clips: [],
      song: { ...fixture.song, tracks: [], placements: [] },
    });
    const empty = await screen.findByRole("region", { name: "No track selected" });
    expect(empty).toHaveTextContent(
      "Select a sampler or drum machine track in the arrangement to browse sounds for it.",
    );
    expect(
      within(empty)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1Arrangement"]);
  });

  it("lands on /library from a slot and on 4, and logs how it was reached", async () => {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    if (!(await repository.createProject(project)).ok) throw new Error("no fixture");
    const transport = createRecordingTransport();
    const { location } = renderEditor(project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      analytics: recordingAnalytics(transport),
    });
    await openLibrary();
    expect(location.get()).toMatch(/\/library$/);
    fireAndFlush(() => fireEvent.keyDown(window, { key: "3" }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/instrument$/));
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    await vi.waitFor(() => expect(location.get()).toMatch(/\/library$/));
    const reached = transport.events.filter(
      (event) => event.name === "view_changed" && event.params?.view === "library",
    );
    expect(reached.map((event) => event.params?.via)).toEqual(["slot", "keyboard"]);
  });
});

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

/** The LOOP-003 transport surface: tempo, 4/4 display, loop, and metronome. */
/**
 * Opens the library from the sampler's sample slot (`UI-001`), which is the
 * only way in now that the always-on column is gone.
 */
/**
 * The sampler's own panel. Its sound's name also shows in the instrument
 * header above it (#447), so a lookup by that name is scoped to the panel.
 */
function sampler(): HTMLElement {
  return screen.getByRole("region", { name: "Sampler" });
}

/** Select a sound (auditioning it), then commit it with the modal's Insert (LIB-010). */
async function insertSound(name: string): Promise<void> {
  // The shelf opens on the slot's family, so find the sound by name first.
  fireEvent.input(await screen.findByRole("searchbox", { name: "Search sounds" }), {
    target: { value: name },
  });
  fireEvent.click(await screen.findByRole("button", { name: `Audition ${name}` }));
  clickAndFlush(await screen.findByRole("button", { name: `Insert ${name}` }));
}

/** The sound a slot names, apart from the Library's key it also shows. */
const slotSound = (label: string) =>
  screen.getByRole("button", { name: label }).querySelector(".sample-slot-name")
    ?.textContent;

/** Opens the Library from the drum machine's selected pad slot. */
async function openLibraryFromPad(): Promise<HTMLElement> {
  await goToView("Instrument");
  clickAndFlush(await screen.findByRole("button", { name: /^Sample for / }));
  return screen.findByRole("region", { name: "Library" });
}

async function openLibrary(): Promise<HTMLElement> {
  await goToView("Instrument");
  clickAndFlush(await screen.findByRole("button", { name: "Sample" }));
  return screen.findByRole("region", { name: "Library" });
}

/** Leaves the Library view by a view key: a view has no close (UI-002). */
/** The Library's Insert button has inserted and gone back (`UI-002`). */
async function backFromInsert(): Promise<void> {
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull(),
  );
}

async function leaveLibrary(key = "3"): Promise<void> {
  fireAndFlush(() => fireEvent.keyDown(window, { key }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull(),
  );
}

/** A pointer event at bar 1 of the first arrangement row, where the slice
 * fixture's only placement sits. The canvas has no DOM node to aim at. */
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

function firePointerAtStarterClip(canvas: Element, type: string): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: (768 / 2) * 0.08,
    clientY: 22 + 28 / 2,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireAndFlush(() => fireEvent(canvas, event));
}

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

  const panel = () => screen.queryByRole("region", { name: "Assistant" });
  const panelButton = (name: string) =>
    within(screen.getByRole("region", { name: "Assistant" })).getByRole("button", {
      name,
    });
  const launcher = () => screen.getByRole("button", { name: /^Assistant$/ });
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
      name: "Message the assistant",
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
      name: "Message the assistant",
    });
    composer.focus();
    fireAndFlush(() => fireEvent.input(composer, { target: { value: text } }));
    press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return client.last().request;
  }

  const scopeChip = () =>
    within(screen.getByRole("region", { name: "Assistant" })).getByRole("button", {
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
    within(panel() as HTMLElement).queryByRole("region", { name: "The assistant asks" });
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
      name: "Message the assistant",
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
    const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
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
        name: "Message the assistant",
      }),
    ).toBeInTheDocument();
  });

  it("offers a sign-in in place of the composer to someone not signed in (GRV-26)", async () => {
    await renderSlice();
    await openPanel();
    expect(panel()).toHaveFocus();
    expect(within(panel() as HTMLElement).queryByRole("textbox")).toBeNull();
    expect(panel()).toHaveTextContent("Sign in to talk to the assistant.");
  });

  it("puts the Assistant button first in the header's document zone: Assistant, Export, Help", async () => {
    await renderSlice();
    const end = document.querySelector(".editor-header-end") as HTMLElement;
    const names = within(end)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    const order = ["Assistant", "Export", "Keyboard shortcuts"].map((name) =>
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
    expect(within(guide).getByText("Open or close the assistant")).toBeInTheDocument();
  });
});

describe("EditorView personal sounds (#282)", () => {
  const OWNER = "u1";
  const PACK = "pak_fieldfieldfieldfield1" as PackId;
  const SOUND = "ast_tapekicktapekicktape1";
  const SECOND = "ast_doorslamdoorslamdoor1";

  /** One of the producer's own sounds, as an import stores it. */
  function personalSound(id: string, name: string): NewUserPackAsset {
    return {
      id: id as NewUserPackAsset["id"],
      name,
      type: "one-shot",
      family: "drums",
      role: "kick",
      storagePath: packAudioPath(OWNER, PACK, id),
      contentType: "audio/wav",
      sizeBytes: 8,
      durationSeconds: 0.1,
      sampleRate: 44_100,
      channelCount: 1,
      bpm: null,
      peaks: null,
      createdAt: 1,
    };
  }

  /** Import another sound into the pack: its next minor version. */
  async function importSecondSound(userLibraryRepository: UserLibraryRepository) {
    const path = packAudioPath(OWNER, PACK, SECOND);
    await userLibraryRepository.uploadAudio(
      path,
      new Blob([new Uint8Array(8)]),
      "audio/wav",
    );
    const pack = await userLibraryRepository.updatePack(OWNER, PACK, (current) =>
      addSound(current, personalSound(SECOND, "door slam"), 3),
    );
    expect(pack.version).toBe("1.2.0");
    return pack;
  }

  /** Wait until the editor's own copy of My packs lists `count` sounds in the pack. */
  async function myPackHolds(count: number): Promise<void> {
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    const myPacks = await screen.findByRole("region", { name: "My packs" });
    await vi.waitFor(() =>
      expect(
        within(myPacks).getByRole("button", { name: /Field Recordings/ }),
      ).toHaveTextContent(String(count)),
    );
  }

  /**
   * The drum-machine fixture with its first pad playing the producer's own
   * "tape kick", inserted the way the library inserts any sound, and the
   * producer's pack holding it.
   */
  async function seedPersonalSound(options: { deletedBeforeOpening?: boolean } = {}) {
    const userLibraryRepository = createInMemoryUserLibraryRepository();
    const path = packAudioPath(OWNER, PACK, SOUND);
    await userLibraryRepository.uploadAudio(
      path,
      new Blob([new Uint8Array(8)]),
      "audio/wav",
    );
    const pack = addSound(
      newUserPack(PACK, "Field Recordings", 1),
      personalSound(SOUND, "tape kick"),
      2,
    );
    await userLibraryRepository.createPack(OWNER, pack);

    const sample = toLibrarySample(userPackAssets(pack)[0]);
    if (!sample) throw new Error("expected an insertable personal sound");
    const fixture = createDrumMachineFixtureProject();
    const [drums] = fixture.song.tracks;
    if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const seeded = executeTransaction(
      fixture,
      loadPadSampleCommands(
        fixture,
        drums.id,
        drums.instrument.pads[0].id,
        sample,
        createFactoryContext(),
      ),
    );
    if (!seeded.ok) throw new Error(seeded.issues[0].message);
    repository = inMemoryModule.createInMemoryProjectRepository();
    const created = await repository.createProject(seeded.project);
    if (!created.ok) throw new Error("fixture project failed to create");
    if (options.deletedBeforeOpening) {
      await deleteUserSound(userLibraryRepository, OWNER, PACK, SOUND, systemClock);
    }
    renderEditor(seeded.project.metadata.id, {
      createAuditionEngine: () => fakePreviewEngine(),
      libraryClient: new LibraryClient(fixtureFetcher()),
      account: { uid: OWNER, registered: true },
      userLibraryRepository: async () => userLibraryRepository,
    });
    return { userLibraryRepository, project: seeded.project };
  }

  it("inserts a sound added to the pack since the project pinned it, without asking", async () => {
    const { userLibraryRepository, project } = await seedPersonalSound();
    await importSecondSound(userLibraryRepository);
    await myPackHolds(2);

    // Pad two, which still plays a factory sound.
    const [drums] = project.song.tracks;
    if (drums.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const second = drums.instrument.pads[1];
    await goToView("Instrument");
    clickAndFlush(await screen.findByRole("button", { name: `Audition ${second.name}` }));
    clickAndFlush(screen.getByRole("button", { name: `Sample for ${second.name}` }));
    const library = await screen.findByRole("region", { name: "Library" });
    await insertSound("door slam");

    // Adding a sound to one's own pack is a safe upgrade: nothing to ask.
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: "Library" })).not.toBeInTheDocument(),
    );
    expect(within(library).queryByRole("button", { name: "Upgrade anyway" })).toBeNull();
    expect(slotSound(`Sample for ${second.name}`)).toBe("door slam");
  });

  it("loads a dropped sound added to the pack since the project pinned it", async () => {
    const userLibraryRepository = createInMemoryUserLibraryRepository();
    const path = packAudioPath(OWNER, PACK, SOUND);
    await userLibraryRepository.uploadAudio(
      path,
      new Blob([new Uint8Array(8)]),
      "audio/wav",
    );
    const first = addSound(
      newUserPack(PACK, "Field Recordings", 1),
      personalSound(SOUND, "tape kick"),
      2,
    );
    await userLibraryRepository.createPack(OWNER, first);
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createSliceFixtureProject();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    renderEditor(project.metadata.id, {
      libraryClient: new LibraryClient(fixtureFetcher()),
      account: { uid: OWNER, registered: true },
      userLibraryRepository: async () => userLibraryRepository,
    });
    const dropOnSampler = async (pack: typeof first, index: number) => {
      const sample = toLibrarySample(userPackAssets(pack)[index]);
      if (!sample) throw new Error("expected an insertable personal sound");
      await goToView("Instrument");
      const panel = await screen.findByRole("region", { name: "BD instrument" });
      fireEvent.drop(panel, { dataTransfer: transferCarrying(sample) });
    };

    // The first drop pins the project to the pack as it stands, 1.1.0.
    await myPackHolds(1);
    await dropOnSampler(first, 0);
    expect(await within(sampler()).findByText("tape kick")).toBeInTheDocument();

    // A sound imported since is in 1.2.0, and every sound the project already
    // uses is still there: the drop upgrades the pin rather than doing nothing.
    const newer = await importSecondSound(userLibraryRepository);
    await myPackHolds(2);
    await dropOnSampler(newer, 1);
    expect(await within(sampler()).findByText("door slam")).toBeInTheDocument();
  });

  it("reports a sound deleted before the project opened as soon as it opens", async () => {
    await seedPersonalSound({ deletedBeforeOpening: true });
    const report = await screen.findByRole("region", { name: "Missing sounds" });
    expect(report).toHaveTextContent(
      "tape kick was deleted from Field Recordings. Track: Drums. Clip: Beat.",
    );
  });

  it("carries no URL for a personal sound into the project", async () => {
    const { project } = await seedPersonalSound();
    const carried = project.song.assets.find((asset) => asset.name === "tape kick");
    expect(carried).toMatchObject({
      storageRef: packAudioPath(OWNER, PACK, SOUND),
      url: null,
    });
  });

  it("reports an in-use sound deleted from My packs as missing, naming its track and clip", async () => {
    const { userLibraryRepository } = await seedPersonalSound();
    await screen.findByTestId("arrangement-view-ready");
    // Nothing is missing while the sound is in its pack.
    await screen.findByRole("navigation", { name: "Views" });
    expect(screen.queryByRole("region", { name: "Missing sounds" })).toBeNull();

    // Delete it from My packs, in the Library view: it warns first.
    fireAndFlush(() => fireEvent.keyDown(window, { key: "4" }));
    const myPacks = await screen.findByRole("region", { name: "My packs" });
    clickAndFlush(
      await within(myPacks).findByRole("button", { name: /Field Recordings/ }),
    );
    // The pack's sounds are in the main region, beside the rail (GRV-52).
    const packSounds = screen.getByRole("region", { name: "Pack sounds" });
    clickAndFlush(within(packSounds).getByRole("button", { name: "Delete sound" }));
    expect(within(packSounds).getByRole("alert")).toHaveTextContent(
      /This project uses this sound/,
    );
    clickAndFlush(within(packSounds).getByRole("button", { name: "Delete" }));

    const report = await screen.findByRole("region", { name: "Missing sounds" });
    expect(report).toHaveTextContent(
      "tape kick was deleted from Field Recordings. Track: Drums. Clip: Beat.",
    );
    expect(
      await userLibraryRepository
        .readAudio(packAudioPath(OWNER, PACK, SOUND))
        .catch((error: { reason: string }) => error.reason),
    ).toBe("not_found");
  });
});

/**
 * A factory pack the published library withdraws (#78): the project still
 * opens, and says which of its sounds went with the pack and what they leave
 * silent, rather than failing or quietly playing nothing.
 */
describe("EditorView withdrawn factory packs", () => {
  /** The committed library, with `slug` taken out of its pack index. */
  function libraryWithout(slug: string | null): LibraryClient {
    const serve = fixtureFetcher();
    return new LibraryClient(async (path) => {
      const document = await serve(path);
      if (path !== PACK_INDEX_PATH || slug === null) return document;
      const index = document as { packs: { slug: string }[] };
      return { ...index, packs: index.packs.filter((pack) => pack.slug !== slug) };
    });
  }

  async function openStarter(libraryClient: LibraryClient) {
    repository = inMemoryModule.createInMemoryProjectRepository();
    const project = createStarterProject("owner-1", () => 0.5);
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("starter project failed to create");
    renderEditor(project.metadata.id, { libraryClient });
    await screen.findByTestId("arrangement-view-ready");
    return project;
  }

  it("names the sound, track and clip a withdrawn pack takes down", async () => {
    const project = await openStarter(libraryWithout("core-electronic-drums"));
    const [kick] = project.song.assets;
    const report = await screen.findByRole("region", { name: "Missing sounds" });
    expect(report).toHaveTextContent(
      "A sound this project uses is missing from your library.",
    );
    expect(report).toHaveTextContent(
      `${kick.name} was in a library pack that is no longer available. Track: BD. Clip: Four on the floor.`,
    );
    // The project is reported on, not rewritten: it is still the one saved.
    const loaded = await repository.loadProject(project.metadata.id);
    if (!loaded.ok) throw new Error("expected the project to load");
    expect(loaded.value.song.assets).toEqual(project.song.assets);
  });

  it("exports anyway, saying first that the file may go without the sound", async () => {
    await openStarter(libraryWithout("core-electronic-drums"));
    await screen.findByRole("region", { name: "Missing sounds" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    expect(within(dialog).getByText("1 missing sound may be left out.")).toBeVisible();
  });

  it("reports nothing while the library still lists the pack", async () => {
    await openStarter(libraryWithout(null));
    await screen.findByRole("navigation", { name: "Views" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    expect(screen.queryByRole("region", { name: "Missing sounds" })).toBeNull();
  });

  it("reports nothing when the library index cannot be read", async () => {
    await openStarter(
      new LibraryClient(async () => {
        throw new Error("offline");
      }),
    );
    await screen.findByRole("navigation", { name: "Views" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    expect(screen.queryByRole("region", { name: "Missing sounds" })).toBeNull();
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
