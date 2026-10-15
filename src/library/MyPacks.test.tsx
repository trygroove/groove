import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { Show } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { createSeededIdFactory } from "../domain/ids";
import { createManualClock } from "../shared/clock";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import { MAX_PACK_SOUNDS, USER_DATA_CAP_BYTES } from "../userData/userData";
import {
  createInMemoryUserLibraryRepository,
  type InMemoryUserLibraryRepository,
} from "../userLibrary/inMemoryUserLibraryRepository";
import type { AudioDecoder } from "../userLibrary/soundAnalysis";
import type { UserPackAsset } from "../userLibrary/userPacks";
import {
  type UserLibrary,
  type UserLibraryAccount,
  useUserLibrary,
} from "../userLibrary/useUserLibrary";
import MyPackFiles from "./MyPackFiles";
import MyPacks from "./MyPacks";
import type { LibraryAsset } from "./manifest";
import type { SoundsKeyAction } from "./soundKeys";

vi.mock("../auth/authService", () => ({
  authService: { linkWithGoogle: vi.fn() },
}));

afterEach(cleanup);

const decode: AudioDecoder = async () => ({
  duration: 0.1,
  numberOfChannels: 1,
  getChannelData: () => Float32Array.from([0.2, -0.7, 0.4]),
});

const REGISTERED: UserLibraryAccount = { uid: "u1", registered: true };

/** A dropped file, as the browser hands it over. */
function audioFile(name: string, type = "audio/wav", bytes = 64): File {
  const data = new Uint8Array(bytes).fill(1);
  const file = new File([data], name, { type });
  // jsdom's File has no `arrayBuffer()`; a browser's always does.
  Object.defineProperty(file, "arrayBuffer", { value: async () => data.buffer });
  return file;
}

/** The parts of a drag event the drop targets read. */
function transfer(files: File[]) {
  return {
    files,
    types: ["Files"],
    items: files.map((file) => ({ kind: "file", type: file.type })),
    dropEffect: "none",
  };
}

function drop(target: Element, files: File[]): void {
  const dataTransfer = transfer(files);
  fireAndFlush(() => {
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
  });
}

function setUp(
  options: {
    account?: UserLibraryAccount | null;
    repository?: InMemoryUserLibraryRepository;
    /** Hands the repository over when this settles, not straight away. */
    repositoryReady?: Promise<void>;
    /**
     * Leave the open pack's sounds unrendered. A test that fills a pack to
     * its limit would otherwise draw hundreds of rows, slow enough in jsdom
     * to time out on a busy runner.
     */
    hideFiles?: boolean;
  } = {},
) {
  const repository = options.repository ?? createInMemoryUserLibraryRepository();
  const [account, setAccount] = createSignal<UserLibraryAccount | null>(
    options.account === undefined ? REGISTERED : options.account,
  );
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const auditioned: LibraryAsset[] = [];
  const similar: LibraryAsset[] = [];
  const favourited: string[] = [];
  const [playingId, setPlayingId] = createSignal<string | null>(null);
  // The modal's selection, which an audition moves, as the library's own
  // audition does when it reports the sound it started.
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  // The view's key handler, as the modal takes it (GRV-76).
  let keys: ((action: SoundsKeyAction) => void) | null = null;
  let library!: UserLibrary;
  function Harness() {
    library = useUserLibrary({
      account,
      repository: async () => {
        await options.repositoryReady;
        return repository;
      },
      analytics,
      decode,
      ids: createSeededIdFactory("my-packs"),
      clock: createManualClock(1_000),
    });
    // The library window's two halves: the rail's packs, and the open
    // pack's sounds in the main region (GRV-52).
    const [openId, setOpenId] = createSignal<string | null>(null);
    const openPack = () => library.packs().find((pack) => pack.id === openId()) ?? null;
    return (
      <>
        <MyPacks library={library} openId={openId()} onOpen={setOpenId} />
        <Show when={!options.hideFiles && openPack()}>
          {(pack) => (
            <MyPackFiles
              library={library}
              pack={pack()}
              selectedId={selectedId()}
              playingId={playingId()}
              onAudition={(asset) => {
                auditioned.push(asset);
                setSelectedId(asset.id);
              }}
              onSimilar={(asset) => similar.push(asset)}
              onKeys={(handler) => {
                keys = handler;
              }}
              favourites={{
                isFavourite: (sound) => favourited.includes(sound.assetId),
                toggle: (sound) => favourited.push(sound.assetId),
              }}
              onClose={() => setOpenId(null)}
            />
          )}
        </Show>
      </>
    );
  }
  const rendered = render(() => <Harness />);
  return {
    repository,
    transport,
    library: () => library,
    auditioned,
    similar,
    favourited,
    setPlayingId,
    setAccount,
    /** Press one of the library's keys, as the modal forwards it. */
    press: (action: SoundsKeyAction) => fireAndFlush(() => keys?.(action)),
    hasKeys: () => keys !== null,
    unmount: rendered.unmount,
  };
}

/** The packs have loaded once Add pack is live. */
const loaded = () =>
  waitFor(() => expect(screen.getByRole("button", { name: "Add pack" })).toBeEnabled());

const region = () => screen.getByRole("region", { name: "My packs" });
/** The open pack's sounds, in the main region. */
const files = () => screen.getByRole("region", { name: "Pack sounds" });
const packItem = (name: RegExp | string) =>
  screen.getAllByRole("listitem").find((item) =>
    within(item).queryByRole("button", {
      name: typeof name === "string" ? new RegExp(name) : name,
    }),
  ) as HTMLElement;

async function addNamedPack(name: string): Promise<HTMLElement> {
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Add pack" }));
  const input = await screen.findByRole("textbox", { name: "Pack name" });
  fireEvent.input(input, { target: { value: name } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Pack name" })).toBeNull(),
  );
  await screen.findByRole("button", { name: new RegExp(name) });
  return packItem(name);
}

/** The name an import takes from a filename: no extension, no separators. */
const soundName = (file: string) => file.replace(".wav", "").replaceAll("-", " ");

/** An open pack with three sounds in it, in the order they were added. */
async function packOfThree(): Promise<HTMLElement> {
  const pack = await addNamedPack("Field Recordings");
  for (const file of ["one-kick.wav", "two-snare.wav", "three-hat.wav"]) {
    drop(pack, [audioFile(file)]);
    await within(files()).findByRole("button", {
      name: `Audition ${soundName(file)}`,
    });
  }
  return pack;
}

/** The open pack's sound rows, by their main button. */
const soundMains = () => within(files()).getAllByRole("button", { name: /^Audition / });
const nameOfMain = (main: HTMLElement) =>
  (main.getAttribute("aria-label") ?? "").replace("Audition ", "");

/** The sound the list shows selected, by name. */
const selectedName = () =>
  soundMains()
    .filter((main) => main.getAttribute("aria-pressed") === "true")
    .map(nameOfMain)[0] ?? null;

/** The sounds whose row holds the list's one Tab stop. */
const tabStops = () =>
  soundMains()
    .filter((main) => main.tabIndex === 0)
    .map(nameOfMain);

/** One row's `tabindex`es: its main button, then its rename and delete. */
const rowTabbable = (name: string): number[] => {
  const row = within(files())
    .getByRole("button", { name: `Audition ${name}` })
    .closest("li") as HTMLElement;
  return [`Audition ${name}`, "Rename sound", "Delete sound"].map(
    (label) => within(row).getByRole("button", { name: label }).tabIndex,
  );
};

describe("My packs", () => {
  it("makes a pack with Add pack and keeps the name typed when Return is pressed", async () => {
    const { transport } = setUp();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add pack" }));
    const input = await screen.findByRole("textbox", { name: "Pack name" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("New pack");

    await addNamedPack("Field Recordings");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Field Recordings/ })).toBeVisible(),
    );
    expect(transport.named("user_pack_created")).toEqual([
      {
        name: "user_pack_created",
        params: expect.objectContaining({ method: "button" }),
      },
      {
        name: "user_pack_created",
        params: expect.objectContaining({ method: "button" }),
      },
    ]);
  });

  it("keeps the default name when the producer clicks away", async () => {
    setUp();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add pack" }));
    const input = await screen.findByRole("textbox", { name: "Pack name" });
    fireEvent.input(input, { target: { value: "Half typed" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /New pack/ })).toBeVisible(),
    );
    expect(screen.queryByRole("button", { name: /Half typed/ })).toBeNull();
  });

  it("imports each dropped file with its own progress, and lists it when it lands", async () => {
    const repository = createInMemoryUserLibraryRepository({ uploadMs: 30 });
    const { transport } = setUp({ repository });
    const pack = await addNamedPack("Field Recordings");

    drop(pack, [audioFile("room-tone.wav"), audioFile("tape-kick.wav")]);

    // One row per file, each with its own progress, while they upload.
    await waitFor(() =>
      expect(
        within(files()).getAllByRole("progressbar", { name: "Upload progress" }),
      ).toHaveLength(2),
    );
    await waitFor(() => {
      expect(within(files()).getAllByRole("button", { name: /^Audition / })).toHaveLength(
        2,
      );
      expect(within(files()).queryByRole("progressbar")).toBeNull();
    });
    expect(
      within(files()).getByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    expect(transport.named("sound_imported")).toHaveLength(2);
    expect(transport.named("sound_imported")[0].params).toMatchObject({
      method: "drop",
    });
  });

  it("auditions a personal sound through the library", async () => {
    const { auditioned } = setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    fireEvent.click(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    );
    expect(auditioned.map((asset) => asset.name)).toEqual(["tape kick"]);
  });

  it("shows a personal sound in the standard sound row, with rename and delete left of the heart (GRV-75)", async () => {
    const { similar, favourited, setPlayingId } = setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    const main = await within(files()).findByRole("button", {
      name: "Audition tape kick",
    });
    const row = main.closest("li") as HTMLElement;

    // The row built-in packs' sounds use: play state, waveform, name over
    // `pack · role`, and length.
    expect(row).toHaveClass("sound-row");
    expect(main.querySelector(".sound-row-play svg")).not.toBeNull();
    expect(main.querySelector("svg.mini-waveform")).not.toBeNull();
    expect(main.querySelector(".sound-row-meta")).toHaveTextContent(
      /^Field Recordings · /,
    );
    expect(main.querySelector(".sound-row-length")).toHaveTextContent("0.10 s");
    // The producer named it, so replay masks it, as it did before.
    expect(main.querySelector(".sound-row-name")).toHaveClass("ph-mask");

    // Rename and delete come before the heart and similar sounds, which keep
    // the last two places they have on every other row.
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Audition tape kick",
      "Rename sound",
      "Delete sound",
      "Favourite tape kick",
      "Sounds like tape kick",
    ]);
    clickAndFlush(within(row).getByRole("button", { name: "Favourite tape kick" }));
    expect(favourited).toHaveLength(1);
    clickAndFlush(within(row).getByRole("button", { name: "Sounds like tape kick" }));
    expect(similar.map((asset) => asset.name)).toEqual(["tape kick"]);

    // While it plays, its play mark is the stop mark, as on any other row.
    const idle = main.querySelector(".sound-row-play")?.innerHTML;
    fireAndFlush(() => setPlayingId(favourited[0]));
    expect(main.querySelector(".sound-row-play")?.innerHTML).not.toBe(idle);
  });

  it("walks the open pack's sounds with the arrow keys, auditioning each (GRV-76)", async () => {
    const { press, auditioned } = setUp();
    await packOfThree();

    // Down from nothing selected starts at the first sound.
    press("library.select_next");
    expect(auditioned.map((asset) => asset.name)).toEqual(["one kick"]);
    expect(selectedName()).toBe("one kick");

    press("library.select_next");
    press("library.select_next");
    expect(auditioned.map((asset) => asset.name)).toEqual([
      "one kick",
      "two snare",
      "three hat",
    ]);
    expect(selectedName()).toBe("three hat");

    // The end holds: there is nothing past the last sound to hear.
    press("library.select_next");
    expect(auditioned).toHaveLength(3);
    expect(selectedName()).toBe("three hat");

    press("library.select_previous");
    expect(auditioned.map((asset) => asset.name)).toEqual([
      "one kick",
      "two snare",
      "three hat",
      "two snare",
    ]);
    expect(selectedName()).toBe("two snare");

    // And so does the start.
    press("library.select_previous");
    press("library.select_previous");
    expect(selectedName()).toBe("one kick");
    expect(auditioned).toHaveLength(5);
  });

  it("hears the selected sound again, and opens its similar sounds, from the keys (GRV-76)", async () => {
    const { press, auditioned, similar } = setUp();
    await packOfThree();

    // With nothing selected both keys have no sound to act on.
    press("library.audition");
    press("library.similar");
    expect(auditioned).toHaveLength(0);
    expect(similar).toHaveLength(0);

    press("library.select_next");
    press("library.audition");
    expect(auditioned.map((asset) => asset.name)).toEqual(["one kick", "one kick"]);
    press("library.similar");
    expect(similar.map((asset) => asset.name)).toEqual(["one kick"]);
  });

  it("makes the open pack's list one Tab stop, which the selection moves (#880)", async () => {
    const { press } = setUp();
    await packOfThree();

    // No selection yet: the first row holds the Tab stop, with its own
    // rename and delete, and every other row is out of the tab order.
    expect(tabStops()).toEqual(["one kick"]);
    expect(rowTabbable("one kick")).toEqual([0, 0, 0]);
    expect(rowTabbable("two snare")).toEqual([-1, -1, -1]);

    press("library.select_next");
    press("library.select_next");
    expect(tabStops()).toEqual(["two snare"]);
    expect(rowTabbable("one kick")).toEqual([-1, -1, -1]);
    expect(rowTabbable("two snare")).toEqual([0, 0, 0]);
  });

  it("takes its key handler back when the pack is left (GRV-76)", async () => {
    const { press, auditioned, hasKeys } = setUp();
    const pack = await packOfThree();
    expect(hasKeys()).toBe(true);
    clickAndFlush(within(files()).getByRole("button", { name: "Back to all sounds" }));
    expect(hasKeys()).toBe(false);
    press("library.select_next");
    expect(auditioned).toHaveLength(0);
    expect(
      within(pack).getByRole("button", { name: /Field Recordings/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("lists an opened pack's sounds in the main region, not in the rail (GRV-52)", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    expect(screen.queryByRole("region", { name: "Pack sounds" })).toBeNull();
    const name = within(pack).getByRole("button", { name: /Field Recordings/ });
    expect(name).toHaveAttribute("aria-pressed", "false");

    clickAndFlush(name);
    expect(name).toHaveAttribute("aria-pressed", "true");
    expect(
      within(files()).getByRole("heading", { name: "Field Recordings" }),
    ).toBeVisible();
    expect(within(files()).getByText(/Nothing in this pack yet/)).toBeVisible();

    drop(pack, [audioFile("tape-kick.wav")]);
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    // The rail stays a list of packs.
    expect(within(region()).queryByRole("button", { name: /^Audition / })).toBeNull();
  });

  it("imports files dropped on the open pack's sounds into that pack", async () => {
    const { transport, repository } = setUp();
    const pack = await addNamedPack("Field Recordings");
    await addNamedPack("Foley");
    clickAndFlush(within(pack).getByRole("button", { name: /Field Recordings/ }));

    drop(files(), [audioFile("room-tone.wav"), audioFile("door-slam.wav")]);

    await waitFor(() =>
      expect(within(files()).getAllByRole("button", { name: /^Audition / })).toHaveLength(
        2,
      ),
    );
    expect(transport.named("sound_imported").map((event) => event.params)).toEqual([
      expect.objectContaining({ method: "drop" }),
      expect.objectContaining({ method: "drop" }),
    ]);
    // Into the pack on screen: no "My Sounds", and Foley is still empty.
    expect(screen.queryByRole("button", { name: /My Sounds/ })).toBeNull();
    const stored = await new Promise<readonly { name: string; assets: unknown[] }[]>(
      (resolve) => {
        const stop = repository.watchPacks(
          "u1",
          (packs) => {
            queueMicrotask(stop);
            resolve(packs as never);
          },
          () => undefined,
        );
      },
    );
    expect(
      Object.fromEntries(stored.map((entry) => [entry.name, entry.assets.length])),
    ).toEqual({ "Field Recordings": 2, Foley: 0 });
  });

  it("refuses a drop on the open pack's sounds with no audio in it", async () => {
    const { repository } = setUp();
    const pack = await addNamedPack("Field Recordings");
    clickAndFlush(within(pack).getByRole("button", { name: /Field Recordings/ }));
    drop(files(), [audioFile("notes.txt", "text/plain")]);
    expect(files()).toHaveAttribute("data-drop", "refused");
    expect(within(files()).getByText("Only audio files can go in a pack.")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.objects.size).toBe(0);
  });

  it("opens the pack dropped on, and My Sounds once a drop beside the packs makes it", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    expect(
      within(files()).getByRole("heading", { name: "Field Recordings" }),
    ).toBeVisible();

    drop(region(), [audioFile("door-slam.wav")]);
    await waitFor(() =>
      expect(within(files()).getByRole("heading", { name: "My Sounds" })).toBeVisible(),
    );
    expect(
      await within(files()).findByRole("button", { name: "Audition door slam" }),
    ).toBeVisible();
  });

  it("adds sounds from the open pack's own Add sounds, reported as the picker", async () => {
    const { transport } = setUp();
    const pack = await addNamedPack("Field Recordings");
    clickAndFlush(within(pack).getByRole("button", { name: /Field Recordings/ }));
    const input = within(files()).getByLabelText(
      "Choose sound files",
    ) as HTMLInputElement;
    const opened = vi.spyOn(input, "click");
    clickAndFlush(within(files()).getByRole("button", { name: "Add sounds" }));
    expect(opened).toHaveBeenCalledTimes(1);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [audioFile("tape-kick.wav")],
    });
    fireAndFlush(() => fireEvent.change(input));
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    expect(transport.named("sound_imported")).toEqual([
      { name: "sound_imported", params: expect.objectContaining({ method: "picker" }) },
    ]);
  });

  it("makes My Sounds from files dropped beside the packs", async () => {
    const { transport } = setUp();
    await loaded();
    drop(region(), [audioFile("door-slam.wav")]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Sounds/ })).toBeVisible(),
    );
    expect(transport.named("user_pack_created")[0].params).toMatchObject({
      method: "drop",
    });
    await waitFor(() => expect(transport.named("sound_imported")).toHaveLength(1));
  });

  it("shows a drop target that takes audio and refuses anything else", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    fireAndFlush(() =>
      fireEvent.dragEnter(pack, { dataTransfer: transfer([audioFile("a.wav")]) }),
    );
    expect(pack).toHaveAttribute("data-drop", "accepted");
    fireAndFlush(() =>
      fireEvent.dragLeave(pack, { dataTransfer: transfer([audioFile("a.wav")]) }),
    );
    expect(pack).toHaveAttribute("data-drop", "none");
    fireAndFlush(() =>
      fireEvent.dragEnter(pack, {
        dataTransfer: transfer([audioFile("notes.txt", "text/plain")]),
      }),
    );
    expect(pack).toHaveAttribute("data-drop", "refused");
    expect(within(pack).getByText("Only audio files can go in a pack.")).toBeVisible();
  });

  it("explains a file it could not import, and reports the failure once", async () => {
    const { transport } = setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("notes.txt", "text/plain"), audioFile("tape-kick.wav")]);
    expect(
      await within(files()).findByText(/Not an audio file we can import/),
    ).toBeVisible();
    expect(transport.named("sound_import_failed")).toEqual([
      {
        name: "sound_import_failed",
        params: expect.objectContaining({ error_code: "unsupported_format" }),
      },
    ]);
    clickAndFlush(within(files()).getByRole("button", { name: "Dismiss" }));
    expect(within(files()).queryByText(/Not an audio file/)).toBeNull();
    // The audio in the same drop still lands.
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
  });

  it("refuses a drop with no audio in it at all, and imports nothing", async () => {
    const { transport, repository } = setUp();
    const pack = await addNamedPack("Field Recordings");
    fireAndFlush(() => drop(pack, [audioFile("notes.txt", "text/plain")]));
    expect(pack).toHaveAttribute("data-drop", "refused");
    expect(within(pack).getByText("Only audio files can go in a pack.")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A refused drop does not open the pack either.
    expect(screen.queryByRole("region", { name: "Pack sounds" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Not an audio file/)).toBeNull();
    expect(transport.named("sound_import_failed")).toEqual([]);
    expect(repository.objects.size).toBe(0);
  });

  it("imports from the file picker, reported as the picker exactly once", async () => {
    const { transport } = setUp();
    const pack = await addNamedPack("Field Recordings");
    const input = screen.getByLabelText("Choose sound files") as HTMLInputElement;
    const opened = vi.spyOn(input, "click");
    clickAndFlush(within(pack).getByRole("button", { name: "Add sounds" }));
    expect(opened).toHaveBeenCalledTimes(1);

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [audioFile("tape-kick.wav")],
    });
    fireAndFlush(() => fireEvent.change(input));

    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    expect(transport.named("sound_imported")).toEqual([
      {
        name: "sound_imported",
        params: expect.objectContaining({ method: "picker" }),
      },
    ]);
  });

  it("waits for a new My Sounds to exist before importing into it", async () => {
    const repository = createInMemoryUserLibraryRepository();
    const createPack = repository.createPack.bind(repository);
    repository.createPack = async (uid, pack) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await createPack(uid, pack);
    };
    const { transport } = setUp({ repository });
    await loaded();
    drop(region(), [audioFile("door-slam.wav")]);
    await waitFor(() => expect(transport.named("sound_imported")).toHaveLength(1));
    expect(transport.named("sound_import_failed")).toEqual([]);
    expect(await screen.findByRole("button", { name: /My Sounds/ })).toBeVisible();
  });

  it("keeps files dropped while the packs are loading, and imports them once they have", async () => {
    let ready: () => void = () => undefined;
    const repositoryReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { transport } = setUp({ repositoryReady });
    expect(screen.getByRole("button", { name: "Add pack" })).toBeDisabled();
    drop(region(), [audioFile("door-slam.wav")]);
    ready();
    await waitFor(() => expect(transport.named("sound_imported")).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: /My Sounds/ })).toHaveLength(1);
  });

  it("cancels uploads in flight when a different account signs in", async () => {
    const repository = createInMemoryUserLibraryRepository({ uploadMs: 5_000 });
    const { transport, setAccount } = setUp({ repository });
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    await within(files()).findByRole("button", { name: "Cancel upload" });

    fireAndFlush(() => setAccount({ uid: "u2", registered: true }));
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.objects.size).toBe(0);
    expect(transport.named("sound_imported")).toEqual([]);
  });

  it("cancels uploads in flight when the editor goes away", async () => {
    const repository = createInMemoryUserLibraryRepository({ uploadMs: 5_000 });
    const { transport, unmount } = setUp({ repository });
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    await within(files()).findByRole("button", { name: "Cancel upload" });
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.objects.size).toBe(0);
    expect(transport.named("sound_imported")).toEqual([]);
  });

  it("offers a retry on a failed upload, and the retried sound lands in its place", async () => {
    const repository = createInMemoryUserLibraryRepository({ failUploads: "unknown" });
    setUp({ repository });
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    expect(await within(files()).findByText("Upload failed. Try again.")).toBeVisible();
    repository.failUploads(null);
    clickAndFlush(within(files()).getByRole("button", { name: "Retry" }));
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    expect(within(files()).queryByText("Upload failed. Try again.")).toBeNull();
    expect(within(files()).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry when the storage rules refuse an upload away from the allowance", async () => {
    const repository = createInMemoryUserLibraryRepository({
      failUploads: "permission_denied",
    });
    setUp({ repository });
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    expect(
      await within(files()).findByText(/Your library couldn't take this sound/),
    ).toBeVisible();
    repository.failUploads(null);
    clickAndFlush(within(files()).getByRole("button", { name: "Retry" }));
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
  });

  it("does not offer a retry for a file that was refused", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("notes.txt", "text/plain"), audioFile("tape-kick.wav")]);
    await within(files()).findByText(/Not an audio file we can import/);
    expect(within(files()).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("cancels an upload, leaving nothing stored and no failure reported", async () => {
    const repository = createInMemoryUserLibraryRepository({ uploadMs: 5_000 });
    const { transport } = setUp({ repository });
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    fireEvent.click(
      await within(files()).findByRole("button", { name: "Cancel upload" }),
    );
    expect(await within(files()).findByText("Cancelled.")).toBeVisible();
    expect(repository.objects.size).toBe(0);
    expect(within(files()).queryByRole("button", { name: /^Audition / })).toBeNull();
    expect(transport.named("sound_import_failed")).toEqual([]);
  });

  it("warns as the account nears its allowance, and refuses a file that would pass it", async () => {
    const repository = createInMemoryUserLibraryRepository();
    repository.setUsage("u1", USER_DATA_CAP_BYTES - 32);
    const { transport } = setUp({ repository });
    expect(await screen.findByText(/Your library is 99% full/)).toBeVisible();
    const pack = await addNamedPack("Field Recordings");

    drop(pack, [audioFile("tape-kick.wav", "audio/wav", 64)]);

    expect(await within(files()).findByText(/Your library is full/)).toBeVisible();
    expect(repository.objects.size).toBe(0);
    expect(transport.named("sound_import_failed")[0].params).toMatchObject({
      error_code: "quota_exceeded",
    });
  });

  it("warns before deleting a sound, then deletes it", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    await within(files()).findByRole("button", { name: "Audition tape kick" });

    clickAndFlush(within(files()).getByRole("button", { name: "Delete sound" }));
    expect(within(files()).getByRole("alert")).toHaveTextContent(/report it missing/);
    clickAndFlush(within(files()).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(within(files()).queryByRole("button", { name: /^Audition / })).toBeNull(),
    );
  });

  it("renames a sound in place, keeping its pack's version", async () => {
    const { repository } = setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    await within(files()).findByRole("button", { name: "Audition tape kick" });

    fireEvent.click(within(files()).getByRole("button", { name: "Rename sound" }));
    const input = await within(files()).findByRole("textbox", { name: "Sound name" });
    expect(input).toHaveValue("tape kick");
    fireEvent.input(input, { target: { value: "Tape Kick, dusty" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(
      await within(files()).findByRole("button", { name: "Audition Tape Kick, dusty" }),
    ).toBeVisible();
    expect(within(files()).queryByRole("textbox", { name: "Sound name" })).toBeNull();
    const [stored] = await new Promise<readonly { version: string }[]>((resolve) => {
      const stop = repository.watchPacks(
        "u1",
        (packs) => {
          queueMicrotask(stop);
          resolve(packs);
        },
        () => undefined,
      );
    });
    expect(stored.version).toBe("1.1.0");
  });

  it("keeps a sound's name when the producer clicks away from renaming it", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    drop(pack, [audioFile("tape-kick.wav")]);
    await within(files()).findByRole("button", { name: "Audition tape kick" });
    fireEvent.click(within(files()).getByRole("button", { name: "Rename sound" }));
    const input = await within(files()).findByRole("textbox", { name: "Sound name" });
    fireEvent.input(input, { target: { value: "Something else" } });
    fireAndFlush(() => fireEvent.blur(input));
    expect(
      await within(files()).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
  });

  it("names a just-made pack what was typed, even before its document is written", async () => {
    const repository = createInMemoryUserLibraryRepository();
    const createPack = repository.createPack.bind(repository);
    let land: () => void = () => undefined;
    repository.createPack = async (uid, pack) => {
      await new Promise<void>((resolve) => {
        land = resolve;
      });
      await createPack(uid, pack);
    };
    setUp({ repository });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add pack" }));
    const input = await screen.findByRole("textbox", { name: "Pack name" });
    fireEvent.input(input, { target: { value: "Foley" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    land();
    expect(await screen.findByRole("button", { name: /Foley/ })).toBeVisible();
    expect(screen.queryByText(/could not be renamed/)).toBeNull();
  });

  it("counts a landed sound against the allowance until the total does", async () => {
    const repository = createInMemoryUserLibraryRepository();
    // The usage total only moves when the Cloud Function counts a file, a
    // moment after it lands: here, only when the test says so.
    let total = USER_DATA_CAP_BYTES - 100;
    const listeners = new Set<(bytes: number) => void>();
    repository.watchUsage = (_uid, onUsage) => {
      listeners.add(onUsage);
      queueMicrotask(() => onUsage(total));
      return () => listeners.delete(onUsage);
    };
    const count = (bytes: number) => {
      total += bytes;
      for (const listener of listeners) listener(total);
    };
    const { transport } = setUp({ repository });
    const pack = await addNamedPack("Field Recordings");

    drop(pack, [audioFile("tape-kick.wav", "audio/wav", 64)]);
    await within(files()).findByRole("button", { name: "Audition tape kick" });

    // The total still says 100 bytes free, but 64 of them are taken.
    drop(pack, [audioFile("door-slam.wav", "audio/wav", 64)]);
    expect(await within(files()).findByText(/Your library is full/)).toBeVisible();
    expect(repository.objects.size).toBe(1);
    expect(transport.named("sound_import_failed")[0].params).toMatchObject({
      error_code: "quota_exceeded",
    });

    // Once the total counts it, the 36 bytes left are free to use.
    fireAndFlush(() => count(64));
    drop(pack, [audioFile("room-tone.wav", "audio/wav", 30)]);
    await within(files()).findByRole("button", { name: "Audition room tone" });
    expect(repository.objects.size).toBe(2);
  });

  it("refuses a sound past a pack's limit before uploading it", async () => {
    const { repository, transport, library } = setUp({ hideFiles: true });
    const pack = await addNamedPack("Field Recordings");
    const [stored] = await new Promise<readonly { id: string }[]>((resolve) => {
      const stop = repository.watchPacks(
        "u1",
        (packs) => {
          queueMicrotask(stop);
          resolve(packs);
        },
        () => undefined,
      );
    });
    const filler = (index: number) =>
      ({
        id: `ast_fill${String(index).padStart(17, "0")}`,
        name: `fill ${index}`,
        type: "one-shot",
        family: "drums",
        role: "kick",
        storagePath: `users/u1/packs/${stored.id}/fill${index}`,
        contentType: "audio/wav",
        sizeBytes: 1,
        durationSeconds: 0.1,
        sampleRate: null,
        channelCount: null,
        bpm: null,
        peaks: null,
        addedInVersion: "1.1.0",
        createdAt: 1,
      }) as UserPackAsset;
    await repository.updatePack("u1", stored.id, (current) => ({
      ...current,
      assets: Array.from({ length: MAX_PACK_SOUNDS - 1 }, (_, index) => filler(index)),
    }));

    // Room for one more: of two files dropped together, the second is refused.
    drop(pack, [audioFile("tape-kick.wav"), audioFile("door-slam.wav")]);
    await waitFor(() =>
      expect(library().imports()).toEqual([
        expect.objectContaining({
          fileName: "door-slam.wav",
          state: "failed",
          message: expect.stringMatching(/This pack is full/),
        }),
      ]),
    );
    await waitFor(() => expect(transport.named("sound_imported")).toHaveLength(1));
    expect(repository.objects.size).toBe(1);
    expect(transport.named("sound_import_failed")[0].params).toMatchObject({
      error_code: "pack_full",
    });
  });

  it("renames and deletes a pack", async () => {
    setUp();
    const pack = await addNamedPack("Field Recordings");
    fireEvent.click(within(pack).getByRole("button", { name: "Rename pack" }));
    const input = await within(pack).findByRole("textbox", { name: "Pack name" });
    fireEvent.input(input, { target: { value: "Foley" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await screen.findByRole("button", { name: /Foley/ });

    const renamed = packItem("Foley");
    clickAndFlush(within(renamed).getByRole("button", { name: "Delete pack" }));
    clickAndFlush(within(renamed).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Foley/ })).toBeNull(),
    );
  });

  it("offers a guest an account instead of a pack", async () => {
    const { repository } = setUp({ account: { uid: "anon", registered: false } });
    fireEvent.click(screen.getByRole("button", { name: "Add pack" }));
    expect(await screen.findByText(/You're working as a guest/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Sign up with Google/ })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Pack name" })).toBeNull();
    expect(repository.objects.size).toBe(0);
  });

  it("offers a guest an account when they drop files", async () => {
    setUp({ account: null });
    drop(region(), [audioFile("tape-kick.wav")]);
    expect(await screen.findByText(/You're working as a guest/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /My Sounds/ })).toBeNull();
  });
});
