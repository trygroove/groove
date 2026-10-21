import { cleanup, fireEvent, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import { executeTransaction } from "../../commands";
import { createFactoryContext } from "../../domain/factories";
import {
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import type { PackId } from "../../domain/ids";
import { fakePreviewEngine } from "../../library/__fixtures__/fakePreviewEngine";
import { fixtureFetcher } from "../../library/__fixtures__/fixtures";
import { loadPadSampleCommands, toLibrarySample } from "../../library/insertion";
import { LibraryClient } from "../../library/libraryClient";
import { PACK_INDEX_PATH } from "../../library/manifest";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { systemClock } from "../../shared/clock";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { packAudioPath } from "../../userData/userData";
import { createInMemoryUserLibraryRepository } from "../../userLibrary/inMemoryUserLibraryRepository";
import { deleteUserSound } from "../../userLibrary/packOperations";
import type { UserLibraryRepository } from "../../userLibrary/userLibraryRepository";
import {
  addSound,
  type NewUserPackAsset,
  newUserPack,
  userPackAssets,
} from "../../userLibrary/userPacks";
import {
  goToView,
  insertSound,
  loadEditorView,
  renderEditor,
  sampler,
  slotSound,
  transferCarrying,
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
