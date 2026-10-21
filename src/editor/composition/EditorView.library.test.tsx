import { cleanup, fireEvent, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecordingTransport } from "../../analytics/transport";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import { executeTransaction } from "../../commands";
import { type Project, packVersion } from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { loadPadSampleCommands, toLibrarySample } from "../../library/insertion";
import { LibraryClient } from "../../library/libraryClient";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import {
  backFromInsert,
  createStepGridProject,
  DROPPED_HAT,
  drumOneShots,
  goToView,
  insertSound,
  leaveLibrary,
  loadEditorView,
  loopAssetName,
  mixerSelect,
  oneShotAssetName,
  openLibrary,
  openLibraryFromPad,
  openSequenceEditor,
  recordingAnalytics,
  renderEditor,
  sampler,
  slotSound,
  transferCarrying,
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

describe("EditorView", () => {
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
    const { ProjectAudioGraph } = await import("../../audio/ProjectAudioGraph");
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
