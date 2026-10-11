import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import type { PackId } from "../domain/ids";
import { fakePreviewEngine } from "../library/__fixtures__/fakePreviewEngine";
import {
  FIXTURE_PACK_INDEX_DOC,
  fixtureFetcher,
  fixturePackManifest,
} from "../library/__fixtures__/fixtures";
import { LibraryClient } from "../library/libraryClient";
import { packAssets, parsePackManifest } from "../library/manifest";
import { createRecentlyHeardStore } from "../library/recentlyHeard";
import { useFavourites } from "../library/useFavourites";
import { InMemoryFavouritesRepository } from "../persistence/inMemoryFavouritesRepository";
import { createManualClock } from "../shared/clock";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import { createInMemoryUserLibraryRepository } from "../userLibrary/inMemoryUserLibraryRepository";
import { addSound, newUserPack, type UserPackAsset } from "../userLibrary/userPacks";
import { useUserLibrary } from "../userLibrary/useUserLibrary";
import LibraryModal, {
  type LibraryActions,
  type LibraryModalProps,
} from "./LibraryModal";

afterEach(cleanup);

function renderModal(
  overrides: Partial<{
    onInsert: LibraryModalProps["onInsert"];
    previewEngine: ReturnType<typeof fakePreviewEngine>;
  }> = {},
) {
  const engine = overrides.previewEngine ?? fakePreviewEngine();
  const rendered = render(() => (
    <LibraryModal
      client={new LibraryClient(fixtureFetcher())}
      previewEngine={engine}
      onInsert={overrides.onInsert ?? (() => undefined)}
      addedPackIds={[]}
    />
  ));
  return { ...rendered, engine };
}

describe("LibraryModal", () => {
  it("is a named region, not a dialog, holding the library browser (UI-002)", () => {
    renderModal();

    const view = screen.getByRole("region", { name: "Library" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(view).getByRole("region", { name: "Browse sounds" })).toBeVisible();
  });

  it("leaves the search field unfocused on open, so the view keys work at once (#880)", () => {
    renderModal();

    expect(document.activeElement).not.toBe(
      screen.getByRole("searchbox", { name: "Search sounds" }),
    );
  });

  it("disposes the audition engine it was given when it closes", () => {
    // `useLibraryBrowser` disposes the engine on unmount and a disposed
    // `ToneAuditionEngine` stays disposed, so the host has to build a fresh
    // one per open — which is only safe if closing really does dispose
    // (LOOP-013).
    const engine = fakePreviewEngine();
    const { unmount } = renderModal({ previewEngine: engine });
    expect(engine.disposed()).toBe(false);

    unmount();

    expect(engine.disposed()).toBe(true);
  });
});

describe("LibraryModal hot-swap", () => {
  it("auditions a selected sound in the slot, and puts the slot back when it closes", async () => {
    const heard: (string | null)[] = [];
    const slot = {
      preview: vi.fn((asset: { name: string }) => heard.push(asset.name) > 0),
      clear: vi.fn(() => heard.push(null)),
      isPlaying: () => true,
    };
    const engine = fakePreviewEngine();
    const { unmount } = render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={engine}
        slotAudition={slot}
        onInsert={() => undefined}
        addedPackIds={[]}
      />
    ));
    const [first, second] = await screen.findAllByRole("listitem");
    const hear = (row: HTMLElement) =>
      fireEvent.click(row.querySelector(".sound-row-main") as HTMLElement);

    hear(first);
    await waitFor(() => expect(heard).toHaveLength(1));
    hear(second);
    await waitFor(() => expect(slot.preview).toHaveBeenCalledTimes(3));

    // Heard in the beat, not standalone: the transport is running.
    expect(engine.starts).toHaveLength(0);
    // The slot is left on the selected sound: the one Insert would put there.
    const insert = screen.getByRole("button", { name: /^Insert / });
    expect(insert).toHaveTextContent(`Insert ${heard.at(-1)}`);
    unmount();
    expect(heard.at(-1)).toBeNull();
  });
});

describe("LibraryModal shell", () => {
  const pack = FIXTURE_PACK_INDEX_DOC.packs[0];

  function renderShell(
    extra: {
      onInsert?: LibraryModalProps["onInsert"];
      onActions?: (a: LibraryActions | null) => void;
      keyLabel?: (a: string) => string;
    } = {},
  ) {
    return render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        onInsert={extra.onInsert ?? (() => undefined)}
        addedPackIds={[pack.id]}
        path="BD › Drum machine › BD"
        slot="BD"
        current="Rounded Club Kick"
        recentlyHeard={createRecentlyHeardStore(memoryStorage())}
        onActions={extra.onActions}
        keyLabel={extra.keyLabel}
      />
    ));
  }

  async function hearFirstSound() {
    const [row] = await screen.findAllByRole("listitem");
    fireEvent.click(row.querySelector(".sound-row-main") as HTMLElement);
  }

  it("names what it inserts into and the sound there, then Hearing and Insert follow", async () => {
    const onInsert = vi.fn();
    renderShell({ onInsert });
    // The header names the target as a path: track, instrument, slot (UI-002).
    expect(
      screen.getByRole("heading", { name: "Inserting into BD › Drum machine › BD" }),
    ).toBeVisible();
    expect(screen.getByRole("group", { name: "In the slot" })).toHaveTextContent(
      "Rounded Club Kick",
    );
    expect(screen.getByRole("group", { name: "Hearing" })).toHaveTextContent(
      "Nothing yet",
    );
    expect(screen.getByText("Nothing yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();

    await hearFirstSound();

    const insert = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".library-modal-insert");
      expect(button).toBeEnabled();
      return button as HTMLButtonElement;
    });
    expect(insert).toHaveTextContent(/^Insert .+/);
    expect(screen.queryByText("Nothing yet")).toBeNull();
    clickAndFlush(insert);
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it("says Inserted only when an insert went in; a refusal is the footer's", async () => {
    let accept = false;
    renderShell({
      onInsert: () =>
        accept ? { ok: true } : { ok: false, reason: "Couldn't insert it: no sampler." },
    });
    await hearFirstSound();
    const insert = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".library-modal-insert");
      expect(button).toBeEnabled();
      return button as HTMLButtonElement;
    });
    const status = document.querySelector("output.library-modal-inserted");

    clickAndFlush(insert);
    expect(await screen.findByText("Couldn't insert it: no sampler.")).toBeVisible();
    expect(status).toHaveTextContent("");

    accept = true;
    clickAndFlush(insert);
    await waitFor(() => expect(status).toHaveTextContent(/^Inserted /));
    expect(screen.queryByText("Couldn't insert it: no sampler.")).toBeNull();
  });

  it("badges the rail and footer from the registry, and says how to fill a place", async () => {
    renderShell({ keyLabel: (action) => `<${action}>` });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const place = (name: string) => rail.getByRole("button", { name: new RegExp(name) });
    expect(place("All sounds")).toHaveAttribute("aria-current", "true");
    expect(place("Browse packs")).toHaveTextContent("<library.browse_packs>");
    expect(screen.getByRole("group", { name: "In this project" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Shuffle/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toHaveTextContent(
      "<help.shortcut_guide>",
    );

    // Favourites is a list of sounds like All sounds (#815): empty, it says
    // how to fill it, naming the registry's key for Like.
    clickAndFlush(place("Favourites"));
    expect(place("Favourites")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("region", { name: "Browse sounds" })).toBeVisible();
    expect(
      await screen.findByText(
        /^No favourites yet\. Press the heart on a sound, or <library\.like>/,
      ),
    ).toBeVisible();

    // So is Recently heard, which says how a sound gets there.
    clickAndFlush(place("Recently heard"));
    expect(place("Recently heard")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("region", { name: "Browse sounds" })).toBeVisible();
    expect(screen.getByText(/^Nothing heard yet\. Sounds you audition/)).toBeVisible();

    // Shuffle picks from a list of sounds, which Browse packs does not show.
    clickAndFlush(place("Browse packs"));
    expect(screen.getByRole("button", { name: /Shuffle/ })).toBeDisabled();
  });

  it("hands the host its shortcut actions, and takes them back on close", async () => {
    const onActions = vi.fn();
    const { unmount } = renderShell({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;

    await expect(actions.insertSelected()).resolves.toBe(false);
    actions.press("library.select_next");
    actions.showView("packs");
    unmount();
    expect(onActions).toHaveBeenLastCalledWith(null);
  });

  it("clears the search on Escape only from a field with a query in it (#877)", () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    const search = screen.getByRole("searchbox", { name: "Search sounds" });

    // An empty field: nothing to clear.
    search.focus();
    expect(actions.escapeSearch()).toBe(false);

    fireEvent.input(search, { target: { value: "kick" } });
    flush();
    // Focus elsewhere: Escape leaves the query alone.
    search.blur();
    expect(actions.escapeSearch()).toBe(false);
    expect(search).toHaveValue("kick");

    search.focus();
    expect(actions.escapeSearch()).toBe(true);
    flush();
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(actions.escapeSearch()).toBe(false);
  });

  it("opens similar sounds for the selected sound, and backs out of it", async () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    expect(actions.similar()).toBe(false);
    expect(actions.back()).toBe(false);

    await hearFirstSound();
    expect(actions.similar()).toBe(true);
    flush();
    await screen.findByRole("navigation", { name: "Similar sounds trail" });
    expect(screen.queryByRole("region", { name: "Browse sounds" })).toBeNull();
    // The way back names the list it returns to, as the shelf in view calls it.
    expect(screen.getByRole("button", { name: /^Back to All \w+$/ })).toBeVisible();

    expect(actions.back()).toBe(true);
    flush();
    expect(screen.queryByRole("navigation", { name: "Similar sounds trail" })).toBeNull();
    expect(screen.getByRole("region", { name: "Browse sounds" })).toBeVisible();
  });

  it("opens similar sounds from a row's icon and from the S key", async () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    const trail = () =>
      screen.queryByRole("navigation", { name: "Similar sounds trail" });

    clickAndFlush((await screen.findAllByRole("button", { name: /^Sounds like / }))[0]);
    expect(
      await screen.findByRole("navigation", { name: "Similar sounds trail" }),
    ).toBeVisible();
    expect(actions.back()).toBe(true);
    flush();
    expect(trail()).toBeNull();

    await hearFirstSound();
    await waitFor(() => expect(screen.queryByText("Nothing yet")).toBeNull());
    actions.press("library.similar");
    flush();
    expect(
      await screen.findByRole("navigation", { name: "Similar sounds trail" }),
    ).toBeVisible();
  });

  it("moves, re-hears and hops on from the selection in similar sounds by key (#873)", async () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    await hearFirstSound();
    await waitFor(() => expect(screen.queryByText("Nothing yet")).toBeNull());
    actions.press("library.similar");
    flush();
    const list = await screen.findByRole("list", { name: "Similar sounds" });
    const results = () =>
      within(list)
        .getAllByRole("button", { name: /^Audition / })
        .map((b) => b.getAttribute("aria-label")?.replace("Audition ", ""));
    const hearing = () => screen.getByRole("group", { name: "Hearing" });
    const crumbs = () =>
      within(screen.getByRole("navigation", { name: "Similar sounds trail" }))
        .getAllByRole("button")
        .map((b) => b.textContent);
    const [first, second] = results();

    actions.press("library.select_next");
    flush();
    expect(hearing()).toHaveTextContent(first as string);
    actions.press("library.select_next");
    flush();
    expect(hearing()).toHaveTextContent(second as string);
    expect(document.querySelector(".library-modal-insert")).toHaveTextContent(
      `Insert ${second}`,
    );
    actions.press("library.select_previous");
    flush();
    expect(hearing()).toHaveTextContent(first as string);

    expect(crumbs()).toHaveLength(1);
    actions.press("library.similar");
    flush();
    expect(crumbs()).toHaveLength(2);
    expect(crumbs()[1]).toBe(first);
  });

  it("narrows the sounds as you type in the header search", async () => {
    renderShell();
    await screen.findAllByRole("listitem");

    fireEvent.input(screen.getByRole("searchbox", { name: "Search sounds" }), {
      target: { value: "zzzz-no-such-sound" },
    });

    expect(await screen.findByText("No sounds match these filters.")).toBeVisible();
  });

  it("clears the search from its own control, shown only while there is a query", async () => {
    renderShell();
    await screen.findAllByRole("listitem");
    const search = screen.getByRole("searchbox", { name: "Search sounds" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.input(search, { target: { value: "zzzz-no-such-sound" } });
    flush();
    clickAndFlush(screen.getByRole("button", { name: "Clear search" }));

    expect(search).toHaveValue("");
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect((await screen.findAllByRole("listitem")).length).toBeGreaterThan(0);
  });

  it("forwards a library key to the sounds view, and Down leaves the search field", async () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    await screen.findAllByRole("listitem");
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    const search = screen.getByRole("searchbox", { name: "Search sounds" });
    search.focus();

    actions.press("library.select_next");

    await waitFor(() => expect(screen.queryByText("Nothing yet")).toBeNull());
    expect(document.activeElement).not.toBe(search);
    await expect(actions.insertSelected()).resolves.toBe(true);
  });

  it("shuffles from the footer, and the search key focuses the search field", async () => {
    const onActions = vi.fn();
    renderShell({ onActions });
    await screen.findAllByRole("listitem");
    const actions = onActions.mock.calls[0][0] as LibraryActions;

    clickAndFlush(screen.getByRole("button", { name: /Shuffle/ }));
    await waitFor(() => expect(screen.queryByText("Nothing yet")).toBeNull());

    actions.press("library.search");
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search sounds" }),
    );
  });
});

describe("LibraryModal footer and rail", () => {
  const [drums] = FIXTURE_PACK_INDEX_DOC.packs;
  const label = (action: string) => `<${action}>`;

  function renderSlot(fetcher = fixtureFetcher()) {
    const slot = { preview: () => true, clear: () => {}, isPlaying: () => true };
    render(() => (
      <LibraryModal
        client={new LibraryClient(fetcher)}
        previewEngine={fakePreviewEngine()}
        slotAudition={slot}
        slotKind="drum-pad"
        slot="BD"
        current="Rounded Club Kick"
        keyLabel={label}
        onInsert={() => undefined}
        addedPackIds={[drums.id]}
      />
    ));
    return within(screen.getByRole("navigation", { name: "Places" }));
  }
  const hint = () => document.querySelector(".library-modal-hint");

  it("teaches the slot and its keys, with different words over packs and similar sounds", async () => {
    const rail = renderSlot();
    await screen.findAllByRole("listitem");
    expect(hint()).toHaveTextContent(
      "Sounds play in the BD pad over your beat. <library.select_previous> " +
        "<library.select_next> for the next, <library.insert_and_return> to insert; leaving puts back Rounded Club Kick.",
    );

    clickAndFlush(rail.getByRole("button", { name: /^Browse packs/ }));
    expect(hint()).toHaveTextContent(/^Pick a pack to see its sounds\.$/);

    clickAndFlush(rail.getByRole("button", { name: /^All sounds/ }));
    clickAndFlush((await screen.findAllByRole("button", { name: /^Sounds like / }))[0]);
    await screen.findByRole("navigation", { name: "Similar sounds trail" });
    expect(hint()).toHaveTextContent(
      /^Every result plays in the BD pad\. Press its similar/,
    );
  });

  it("selects an opened pack's own rail row rather than Browse packs", async () => {
    const rail = renderSlot();
    const browse = rail.getByRole("button", { name: /^Browse packs/ });
    clickAndFlush(browse);
    expect(browse).toHaveAttribute("aria-current", "true");

    clickAndFlush(await screen.findByRole("button", { name: `Open ${drums.name}` }));

    const project = within(screen.getByRole("group", { name: "In this project" }));
    expect(project.getByRole("button", { name: new RegExp(drums.name) })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(browse).not.toHaveAttribute("aria-current");
  });

  it("says the project's packs couldn't load when the pack index fails", async () => {
    renderSlot(async () => {
      throw new Error("offline");
    });
    const project = screen.getByRole("group", { name: "In this project" });
    expect(await within(project).findByText("Packs couldn't load.")).toBeVisible();
  });

  it("badges Insert with the registry's key without changing its name", async () => {
    renderSlot();
    const insert = screen.getByRole("button", { name: "Insert" });
    // The button inserts and goes back, so it carries Enter's key.
    const badge = within(insert).getByText("<library.insert_and_return>");
    expect(badge).toHaveClass("library-modal-key");
    expect(badge).toHaveAttribute("aria-hidden", "true");
  });
});

describe("LibraryModal packs", () => {
  const [drums, bass] = FIXTURE_PACK_INDEX_DOC.packs;

  function renderPacks(addedPackIds: string[] = [drums.id]) {
    let actions: LibraryActions | null = null;
    render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        onInsert={() => undefined}
        addedPackIds={addedPackIds}
        onActions={(next) => {
          actions = next;
        }}
      />
    ));
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    return {
      browsePacks: () =>
        clickAndFlush(rail.getByRole("button", { name: /Browse packs/ })),
      actions: () => actions as unknown as LibraryActions,
    };
  }

  /** The names of the sounds the (scoped) sounds view lists. */
  const listed = () =>
    within(screen.getByRole("list", { name: "Sounds" }))
      .getAllByRole("button", { name: /^Audition / })
      .map((button) => button.getAttribute("aria-label")?.replace(/^Audition /, ""));

  it("advertises only the sounds and categories a pad slot's shelf shows (GRV-48)", async () => {
    // Opened from a pad: one-shots only, so the drum pack's loop and preset
    // never reach the shelf, and no count may promise them.
    render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        slotKind="drum-pad"
        assetTypes={["one-shot"]}
        onInsert={() => undefined}
        addedPackIds={[drums.id]}
      />
    ));
    const shown = packAssets(parsePackManifest(fixturePackManifest(drums.slug))).filter(
      (asset) => asset.type === "one-shot",
    );
    const sounds = shown.length;
    const categories = new Set(shown.map((asset) => asset.role)).size;
    expect(sounds).toBeLessThan(drums.assetCount);
    const meta = new RegExp(`\\b${sounds} sounds\\b.*\\b${categories} categor(y|ies)`);

    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const row = await rail.findByRole("button", { name: new RegExp(drums.name) });
    await waitFor(() =>
      expect(row.querySelector("small")).toHaveTextContent(new RegExp(`^${sounds}$`)),
    );

    clickAndFlush(rail.getByRole("button", { name: /^Browse packs/ }));
    const card = await screen.findByRole("button", { name: `Open ${drums.name}` });
    await waitFor(() => expect(card).toHaveTextContent(meta));

    clickAndFlush(card);
    const banner = await screen.findByRole("region", { name: `About ${drums.name}` });
    await waitFor(() => expect(banner).toHaveTextContent(meta));

    // What the shelf inside the pack actually offers.
    const families = await screen.findByRole("tablist", { name: "Families" });
    await waitFor(() => expect(within(families).getAllByRole("tab")).toHaveLength(1));
    expect(within(families).getByRole("tab")).toHaveTextContent(`${sounds}`);
    // "All drums" plus one chip per category.
    expect(document.querySelectorAll(".shelf-chip")).toHaveLength(categories + 1);
  });

  it("opens on the pack it is asked for, as the assistant's Open in library does (GRV-23)", async () => {
    const [drums] = FIXTURE_PACK_INDEX_DOC.packs;
    const opened = vi.fn();
    render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        onInsert={() => undefined}
        addedPackIds={[]}
        openPack={drums.slug}
        onPackOpened={opened}
      />
    ));
    expect(
      await screen.findByRole("region", { name: `About ${drums.name}` }),
    ).toBeVisible();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("swaps the list for the cover grid under Browse packs", async () => {
    const { browsePacks } = renderPacks();
    browsePacks();

    const grid = await screen.findByRole("region", { name: "Packs" });
    expect(
      await within(grid).findByRole("button", { name: `Open ${bass.name}` }),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "Browse sounds" })).toBeNull();
  });

  it("opens a pack with its banner over a scoped list, and Backspace goes back", async () => {
    const { browsePacks, actions } = renderPacks();
    browsePacks();
    clickAndFlush(await screen.findByRole("button", { name: `Open ${drums.name}` }));

    const banner = await screen.findByRole("region", { name: `About ${drums.name}` });
    expect(banner).toHaveTextContent(drums.publisher);
    expect(banner).toHaveTextContent(`v${drums.version}`);
    expect(banner).toHaveTextContent(drums.description);
    expect(banner).toHaveTextContent("In this project");
    // The sounds view shows, scoped to this pack alone.
    expect(await screen.findByRole("region", { name: "Browse sounds" })).toBeVisible();
    const inPack = new Set(
      packAssets(parsePackManifest(fixturePackManifest(drums.slug))).map((a) => a.name),
    );
    await waitFor(() => expect(listed().length).toBeGreaterThan(0));
    expect(listed().every((name) => inPack.has(name ?? ""))).toBe(true);

    actions().back();
    expect(await screen.findByRole("region", { name: "Packs" })).toBeVisible();
    expect(screen.queryByRole("region", { name: `About ${drums.name}` })).toBeNull();

    actions().back();
    expect(await screen.findByRole("region", { name: "Browse sounds" })).toBeVisible();
  });

  it("says a pack joins the project on insert when the project lacks it", async () => {
    const { browsePacks } = renderPacks([drums.id]);
    browsePacks();
    clickAndFlush(await screen.findByRole("button", { name: `Open ${bass.name}` }));

    const banner = await screen.findByRole("region", { name: `About ${bass.name}` });
    expect(banner).toHaveTextContent("Joins the project when you insert a sound");
  });

  it("backs out of similar sounds, then the pack, then Browse packs", async () => {
    const { browsePacks, actions } = renderPacks();
    browsePacks();
    clickAndFlush(await screen.findByRole("button", { name: `Open ${drums.name}` }));
    clickAndFlush((await screen.findAllByRole("button", { name: /^Sounds like / }))[0]);
    await screen.findByRole("navigation", { name: "Similar sounds trail" });

    expect(actions().back()).toBe(true);
    expect(
      await screen.findByRole("region", { name: `About ${drums.name}` }),
    ).toBeVisible();
    expect(actions().back()).toBe(true);
    expect(await screen.findByRole("region", { name: "Packs" })).toBeVisible();
    expect(actions().back()).toBe(true);
    expect(await screen.findByRole("region", { name: "Browse sounds" })).toBeVisible();
    expect(actions().back()).toBe(false);
  });

  it("leaves an opened pack from its banner's close button", async () => {
    const { browsePacks } = renderPacks();
    browsePacks();
    clickAndFlush(await screen.findByRole("button", { name: `Open ${drums.name}` }));
    const banner = await screen.findByRole("region", { name: `About ${drums.name}` });

    clickAndFlush(within(banner).getByRole("button", { name: "Back to all sounds" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: `About ${drums.name}` })).toBeNull(),
    );
  });

  const allSounds = () =>
    within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", {
      name: /^All sounds/,
    });
  const browse = () =>
    within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", {
      name: /^Browse packs/,
    });
  const closeBanner = async (pack: { name: string }) => {
    const banner = await screen.findByRole("region", { name: `About ${pack.name}` });
    clickAndFlush(within(banner).getByRole("button", { name: "Back to all sounds" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: `About ${pack.name}` })).toBeNull(),
    );
  };
  const familyTab = (name: string) =>
    screen.getByRole("tab", { name: new RegExp(`^${name}`) });

  it("goes to All sounds from a pack opened under Browse packs (#875)", async () => {
    const { browsePacks } = renderPacks();
    browsePacks();
    clickAndFlush(await screen.findByRole("button", { name: `Open ${drums.name}` }));

    await closeBanner(drums);

    expect(allSounds()).toHaveAttribute("aria-current", "true");
    expect(browse()).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("region", { name: "Packs" })).toBeNull();
    expect(screen.getByRole("region", { name: "Library" })).toBeVisible();
  });

  it("goes to All sounds from a pack opened in the rail over Browse packs (#875)", async () => {
    const { browsePacks } = renderPacks([bass.id]);
    browsePacks();
    const project = within(screen.getByRole("group", { name: "In this project" }));
    clickAndFlush(await project.findByRole("button", { name: new RegExp(bass.name) }));

    await closeBanner(bass);

    expect(allSounds()).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("region", { name: "Packs" })).toBeNull();
    expect(screen.getByRole("region", { name: "Library" })).toBeVisible();
  });

  // #1011: the surface a focused control sits on unmounts when a pack opens or
  // closes, so focus has to land somewhere in the new place, not on <body>.
  describe("keeps focus when a pack opens or closes (#1011)", () => {
    const banner = (pack: { name: string }) =>
      screen.findByRole("region", { name: `About ${pack.name}` });

    async function openFromGrid(pack: { name: string }): Promise<void> {
      const open = await screen.findByRole("button", { name: `Open ${pack.name}` });
      open.focus();
      clickAndFlush(open);
    }

    it("moves focus to the pack's banner when Browse packs opens it", async () => {
      const { browsePacks } = renderPacks();
      browsePacks();

      await openFromGrid(drums);

      const opened = await banner(drums);
      await waitFor(() => expect(document.activeElement).toBe(opened));
    });

    it("moves focus to All sounds when the banner's Back to all sounds leaves the pack", async () => {
      const { browsePacks } = renderPacks();
      browsePacks();
      await openFromGrid(drums);
      const close = within(await banner(drums)).getByRole("button", {
        name: "Back to all sounds",
      });
      close.focus();

      clickAndFlush(close);

      await waitFor(() => expect(document.activeElement).toBe(allSounds()));
    });

    it("moves focus to Browse packs when Back leaves a pack for the grid", async () => {
      const { browsePacks, actions } = renderPacks();
      browsePacks();
      await openFromGrid(drums);
      within(await banner(drums))
        .getByRole("button", { name: "Back to all sounds" })
        .focus();

      actions().back();
      flush();

      await screen.findByRole("region", { name: "Packs" });
      await waitFor(() => expect(document.activeElement).toBe(browse()));
    });

    it("moves focus to All sounds when Back leaves the grid of packs", async () => {
      const { browsePacks, actions } = renderPacks();
      browsePacks();
      (await screen.findByRole("button", { name: `Open ${drums.name}` })).focus();

      actions().back();
      flush();

      await screen.findByRole("region", { name: "Browse sounds" });
      await waitFor(() => expect(document.activeElement).toBe(allSounds()));
    });

    it("moves focus from Browse packs to All sounds when Back leaves the grid", async () => {
      const { browsePacks, actions } = renderPacks();
      browsePacks();
      await screen.findByRole("button", { name: `Open ${drums.name}` });
      browse().focus();

      actions().back();
      flush();

      await screen.findByRole("region", { name: "Browse sounds" });
      await waitFor(() => expect(document.activeElement).toBe(allSounds()));
    });

    it("brings focus adrift on <body> back to the new place", async () => {
      const { browsePacks, actions } = renderPacks();
      browsePacks();
      await openFromGrid(drums);
      await banner(drums);
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);

      actions().back();
      flush();

      await screen.findByRole("region", { name: "Packs" });
      await waitFor(() => expect(document.activeElement).toBe(browse()));
    });

    it("holds focus when a double-click's second press lands on the opened pack", async () => {
      const { browsePacks } = renderPacks();
      browsePacks();
      await openFromGrid(drums);
      const opened = await banner(drums);
      const surface = opened.closest(".library-modal-main") as HTMLElement;

      const second = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        detail: 2,
      });
      surface.dispatchEvent(second);
      const onControl = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        detail: 2,
      });
      within(opened)
        .getByRole("button", { name: "Back to all sounds" })
        .dispatchEvent(onControl);
      const single = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      surface.dispatchEvent(single);

      expect(second.defaultPrevented).toBe(true);
      expect(onControl.defaultPrevented).toBe(false);
      expect(single.defaultPrevented).toBe(false);
    });

    it("moves focus to the pack's banner when similar sounds' way back returns to it", async () => {
      const { browsePacks } = renderPacks();
      browsePacks();
      await openFromGrid(drums);
      await banner(drums);
      clickAndFlush((await screen.findAllByRole("button", { name: /^Sounds like / }))[0]);
      const view = await screen.findByRole("region", { name: "Similar sounds view" });
      const way = within(view).getByRole("button", { name: /^Back/ });
      way.focus();

      clickAndFlush(way);

      const back = await banner(drums);
      await waitFor(() => expect(document.activeElement).toBe(back));
    });

    it("leaves focus on a rail pack it opened from, which stays put", async () => {
      renderPacks([bass.id]);
      const project = within(screen.getByRole("group", { name: "In this project" }));
      const railPack = await project.findByRole("button", {
        name: new RegExp(bass.name),
      });
      railPack.focus();

      clickAndFlush(railPack);
      await banner(bass);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.activeElement).toBe(railPack);
    });
  });

  it("leaves All sounds' filters and the heard sound as they were (#875)", async () => {
    renderPacks([drums.id]);
    await screen.findAllByRole("listitem");
    // All sounds, narrowed to Bass and a search.
    clickAndFlush(familyTab("Bass"));
    const search = screen.getByRole("searchbox", { name: "Search sounds" });
    fireEvent.input(search, { target: { value: "Sub" } });
    flush();

    // Open the drums pack, change its filters, and hear one of its sounds.
    const project = within(screen.getByRole("group", { name: "In this project" }));
    clickAndFlush(await project.findByRole("button", { name: new RegExp(drums.name) }));
    await screen.findByRole("region", { name: `About ${drums.name}` });
    fireEvent.input(search, { target: { value: "" } });
    flush();
    clickAndFlush(familyTab("Loops"));
    const groove = await screen.findByRole("button", {
      name: "Audition Four Four Club Groove",
    });
    clickAndFlush(groove);
    const hearing = () =>
      screen.getByText("Hearing", { selector: "legend" }).parentElement as HTMLElement;
    await waitFor(() => expect(hearing()).toHaveTextContent("Four Four Club Groove"));

    await closeBanner(drums);

    expect(allSounds()).toHaveAttribute("aria-current", "true");
    expect(familyTab("Bass")).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveValue("Sub");
    expect(listed().length).toBeGreaterThan(0);
    expect(listed().every((name) => /Sub/.test(name ?? ""))).toBe(true);
    expect(hearing()).toHaveTextContent("Four Four Club Groove");
  });

  it("lists the project's packs in the rail, and opens one", async () => {
    const { actions } = renderPacks([bass.id]);
    const project = within(await screen.findByRole("group", { name: "In this project" }));

    const pack = await project.findByRole("button", { name: new RegExp(bass.name) });
    expect(project.getAllByRole("button")).toHaveLength(1);
    clickAndFlush(pack);

    expect(await screen.findByRole("heading", { name: bass.name })).toBeVisible();
    expect(pack).toHaveAttribute("aria-pressed", "true");
    actions().back();
    await waitFor(() => expect(pack).toHaveAttribute("aria-pressed", "false"));
    expect(screen.queryByRole("heading", { name: bass.name })).toBeNull();
  });
});

describe("LibraryModal refused inserts (#892)", () => {
  async function selectSound(index: number) {
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(rows[index].querySelector(".sound-row-main") as HTMLElement);
    return waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".library-modal-insert");
      expect(button).toBeEnabled();
      return button as HTMLButtonElement;
    });
  }

  const upgrade = { packName: "Core Electronic Drums", version: "1.1.0", missing: 2 };

  it("shows a refusal's sentence beside Insert, keeps the view, and clears it on the next selection", async () => {
    renderModal({
      onInsert: () => ({ ok: false, reason: "Couldn't insert it: no sampler." }),
    });

    clickAndFlush(await selectSound(0));

    expect(await screen.findByText("Couldn't insert it: no sampler.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade anyway" })).toBeNull();

    await selectSound(1);
    await waitFor(() =>
      expect(screen.queryByText("Couldn't insert it: no sampler.")).toBeNull(),
    );
  });

  it("asks before an upgrade that leaves sounds missing, and Upgrade anyway inserts", async () => {
    const onInsert = vi.fn((_asset: unknown, options: { upgradeAnyway: boolean }) =>
      options.upgradeAnyway ? { ok: true as const } : { ok: false as const, upgrade },
    );
    renderModal({ onInsert });

    clickAndFlush(await selectSound(0));

    expect(
      await screen.findByText(
        "Inserting this moves the project to Core Electronic Drums 1.1.0, which leaves 2 sounds in this project missing.",
      ),
    ).toBeVisible();
    expect(onInsert).toHaveBeenLastCalledWith(expect.anything(), {
      upgradeAnyway: false,
    });
    clickAndFlush(screen.getByRole("button", { name: "Upgrade anyway" }));

    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(2));
    expect(onInsert).toHaveBeenLastCalledWith(expect.anything(), { upgradeAnyway: true });
  });

  it("Cancel changes nothing and leaves the couldn't-insert message, still offering the upgrade", async () => {
    const onInsert = vi.fn(() => ({ ok: false as const, upgrade }));
    renderModal({ onInsert });

    clickAndFlush(await selectSound(0));
    clickAndFlush(await screen.findByRole("button", { name: "Cancel" }));

    const notice = document.querySelector(".library-modal-notice");
    expect(notice).toHaveTextContent(
      /^Couldn't insert .+: it needs Core Electronic Drums 1\.1\.0, which leaves 2 sounds in this project missing\./,
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade anyway" })).toBeVisible();
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it("says when the newer version could not be checked, and still offers the upgrade", async () => {
    renderModal({
      onInsert: () => ({ ok: false, upgrade: { ...upgrade, missing: null } }),
    });

    clickAndFlush(await selectSound(0));

    expect(
      await screen.findByText(
        /didn't load, so this project's sounds couldn't be checked/,
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Upgrade anyway" })).toBeVisible();
  });
});

describe("LibraryModal with the producer's own packs (#282)", () => {
  async function renderWithPack(
    extra: { onActions?: (a: LibraryActions | null) => void } = {},
  ) {
    const repository = createInMemoryUserLibraryRepository();
    let pack = newUserPack("pak_mypacksmypacksmypack1" as PackId, "Field Recordings", 1);
    pack = addSound(
      pack,
      {
        id: "ast_tapekicktapekicktape1" as UserPackAsset["id"],
        name: "tape kick",
        type: "one-shot",
        family: "drums",
        role: "kick",
        storagePath: "users/u1/packs/pak_mypacksmypacksmypack1/ast_tapekicktapekicktape1",
        contentType: "audio/wav",
        sizeBytes: 64,
        durationSeconds: 0.1,
        sampleRate: 44_100,
        channelCount: 1,
        bpm: null,
        peaks: null,
        createdAt: 1,
      },
      2,
    );
    await repository.createPack("u1", pack);
    const engine = fakePreviewEngine();
    function Harness() {
      const userLibrary = useUserLibrary({
        account: () => ({ uid: "u1", registered: true }),
        repository: async () => repository,
      });
      return (
        <LibraryModal
          client={new LibraryClient(fixtureFetcher())}
          previewEngine={engine}
          onInsert={() => undefined}
          addedPackIds={[]}
          userLibrary={userLibrary}
          onActions={extra.onActions}
        />
      );
    }
    render(() => <Harness />);
    return { engine };
  }

  const packSounds = () => screen.getByRole("region", { name: "Pack sounds" });

  async function openFieldRecordings(): Promise<HTMLElement> {
    const rail = screen.getByRole("navigation", { name: "Places" });
    const myPacks = within(rail).getByRole("region", { name: "My packs" });
    clickAndFlush(
      await within(myPacks).findByRole("button", { name: /Field Recordings/ }),
    );
    return myPacks;
  }

  it("lists My packs in the rail, and opening one lists its sounds in the main region (GRV-52)", async () => {
    await renderWithPack();
    const myPacks = await openFieldRecordings();
    expect(
      within(myPacks).getByRole("button", { name: /Field Recordings/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // The rail keeps the packs; the files are where every pack's sounds are.
    expect(within(myPacks).queryByRole("button", { name: /^Audition / })).toBeNull();
    const main = document.querySelector(".library-modal-main") as HTMLElement;
    expect(within(main).getByRole("region", { name: "Pack sounds" })).toBe(packSounds());
    expect(
      within(packSounds()).getByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    // The open pack is the place, so All sounds is not the current one.
    expect(screen.getByRole("button", { name: /All sounds/ })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.queryByRole("list", { name: "Sounds" })).toBeNull();
  });

  it("leaves the open personal pack for another place, and for its close button", async () => {
    await renderWithPack();
    await openFieldRecordings();
    clickAndFlush(screen.getByRole("button", { name: /Favourites/ }));
    expect(screen.queryByRole("region", { name: "Pack sounds" })).toBeNull();
    expect(screen.getByRole("button", { name: /Field Recordings/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await openFieldRecordings();
    clickAndFlush(
      within(packSounds()).getByRole("button", { name: "Back to all sounds" }),
    );
    expect(screen.queryByRole("region", { name: "Pack sounds" })).toBeNull();
    expect(screen.getByRole("button", { name: /All sounds/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("uploads files dropped on the main region into the open personal pack", async () => {
    await renderWithPack();
    await openFieldRecordings();
    const data = new Uint8Array(64).fill(1);
    const file = new File([data], "room-tone.wav", { type: "audio/wav" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => data.buffer });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      items: [{ kind: "file", type: file.type }],
      dropEffect: "none",
    };
    fireAndFlush(() => {
      fireEvent.dragEnter(packSounds(), { dataTransfer });
      fireEvent.dragOver(packSounds(), { dataTransfer });
      fireEvent.drop(packSounds(), { dataTransfer });
    });
    // Each file shows its own row in the pack while it uploads, or why it could not.
    expect(await within(packSounds()).findByText("room-tone.wav")).toBeVisible();
  });

  it("finds a personal sound by searching, alongside the factory sounds", async () => {
    await renderWithPack();
    await openFieldRecordings();
    fireAndFlush(() =>
      fireEvent.input(screen.getByRole("searchbox", { name: "Search sounds" }), {
        target: { value: "tape" },
      }),
    );
    const sounds = await screen.findByRole("list", { name: "Sounds" });
    expect(
      await within(sounds).findByRole("button", { name: "Audition tape kick" }),
    ).toBeVisible();
    // The results are the list: the open pack gives way to them.
    expect(screen.queryByRole("region", { name: "Pack sounds" })).toBeNull();
  });

  it("hears a personal sound from its pack through the library's one audition", async () => {
    const { engine } = await renderWithPack();
    await openFieldRecordings();
    clickAndFlush(
      within(packSounds()).getByRole("button", { name: "Audition tape kick" }),
    );
    await waitFor(() =>
      expect(engine.starts.map((start) => start.asset.name)).toContain("tape kick"),
    );
    expect(
      within(packSounds()).getByRole("button", { name: "Audition tape kick" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("sends the list keys to the open personal pack (GRV-76)", async () => {
    const onActions = vi.fn();
    const { engine } = await renderWithPack({ onActions });
    const actions = onActions.mock.calls[0][0] as LibraryActions;
    await openFieldRecordings();

    // Down with nothing selected takes the pack's first sound, and hearing it
    // is what selecting it means, exactly as in the Sounds list.
    actions.press("library.select_next");
    flush();
    await waitFor(() =>
      expect(engine.starts.map((start) => start.asset.name)).toContain("tape kick"),
    );
    const row = within(packSounds()).getByRole("button", {
      name: "Audition tape kick",
    });
    expect(row).toHaveAttribute("aria-pressed", "true");
    // The step takes focus with it, so a screen reader names the sound (#880).
    await waitFor(() => expect(document.activeElement).toBe(row));
    // And it is the list's one Tab stop.
    expect(row).toHaveAttribute("tabindex", "0");
  });
});

describe("LibraryModal favourites (#815)", () => {
  const UID = "user_fav";
  const pack = FIXTURE_PACK_INDEX_DOC.packs[0];
  const packId = pack.id as PackId;

  function renderWithFavourites(repository: InMemoryFavouritesRepository) {
    const onActions = vi.fn();
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    render(() => {
      const favourites = useFavourites({
        uid: () => UID,
        repository: async () => repository,
        analytics,
      });
      return (
        <LibraryModal
          client={new LibraryClient(fixtureFetcher())}
          previewEngine={fakePreviewEngine()}
          onInsert={() => undefined}
          addedPackIds={[pack.id]}
          keyLabel={(action) => (action === "library.like" ? "L" : "")}
          onActions={onActions}
          favourites={favourites}
        />
      );
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    return {
      transport,
      actions: () => onActions.mock.calls[0][0] as LibraryActions,
      favouritesPlace: () => rail.getByRole("button", { name: /^Favourites/ }),
      allSounds: () => rail.getByRole("button", { name: /^All sounds/ }),
    };
  }

  const rows = () =>
    within(screen.getByRole("list", { name: "Sounds" }))
      .getAllByRole("button", { name: /^Audition / })
      .map((button) => button.getAttribute("aria-label")?.replace(/^Audition /, ""));
  const heart = (name: string) =>
    screen.getByRole("button", { name: `Favourite ${name}` });

  it("toggles a favourite with its heart, counting it in the rail", async () => {
    const repository = new InMemoryFavouritesRepository();
    const { favouritesPlace, transport } = renderWithFavourites(repository);
    await screen.findAllByRole("listitem");
    const [first] = rows() as string[];
    await waitFor(() => expect(favouritesPlace()).toHaveTextContent(/^Favourites0/));
    expect(heart(first)).toHaveAttribute("aria-pressed", "false");

    clickAndFlush(heart(first));

    await waitFor(() => expect(heart(first)).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(favouritesPlace()).toHaveTextContent(/^Favourites1/));
    const stored = await repository.listFavourites(UID);
    expect(stored.ok && stored.favourites.map((f) => f.packId)).toEqual([packId]);
    const changes = transport.events.filter(
      (e) => e.name === "library_favourite_changed",
    );
    expect(changes.map((e) => e.params.favourited)).toEqual([true]);
    expect(JSON.stringify(changes[0].params)).not.toContain(first);

    clickAndFlush(heart(first));
    await waitFor(() => expect(heart(first)).toHaveAttribute("aria-pressed", "false"));
    await waitFor(() => expect(favouritesPlace()).toHaveTextContent(/^Favourites0/));
  });

  it("favourites the selected sound on L, and does nothing with none selected", async () => {
    const repository = new InMemoryFavouritesRepository();
    const { actions } = renderWithFavourites(repository);
    const [row] = await screen.findAllByRole("listitem");
    expect(actions().like()).toBe(false);

    fireEvent.click(row.querySelector(".sound-row-main") as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Insert ./ })).toBeVisible(),
    );
    const [first] = rows() as string[];
    expect(actions().like()).toBe(true);

    await waitFor(() => expect(heart(first)).toHaveAttribute("aria-pressed", "true"));
  });

  it("lists only the favourites, newest first, and a missing one as missing", async () => {
    const repository = new InMemoryFavouritesRepository({ clock: createManualClock(1) });
    const { favouritesPlace, allSounds } = renderWithFavourites(repository);
    await screen.findAllByRole("listitem");
    const kicks = rows() as string[];
    expect(kicks.length).toBeGreaterThan(2);
    // Favourite the second kick, then the first: the first is the newest.
    clickAndFlush(heart(kicks[1]));
    await waitFor(() => expect(heart(kicks[1])).toHaveAttribute("aria-pressed", "true"));
    clickAndFlush(heart(kicks[0]));
    await waitFor(() => expect(heart(kicks[0])).toHaveAttribute("aria-pressed", "true"));
    await repository.addFavourite(UID, { packId, assetId: "a-sound-since-removed" });
    await repository.addFavourite(UID, {
      packId: "pak_nopacknopacknopacknop" as PackId,
      assetId: "from-a-pack-gone",
    });
    await waitFor(() => expect(favouritesPlace()).toHaveTextContent(/^Favourites4/));

    clickAndFlush(favouritesPlace());

    await waitFor(() => expect(rows()).toEqual([kicks[0], kicks[1]]));
    const missing = within(screen.getByRole("list", { name: "Missing favourites" }));
    expect(missing.getAllByText("Missing sound")).toHaveLength(2);
    expect(missing.getByText("It's no longer in its pack.")).toBeVisible();
    expect(missing.getByText("Its pack isn't available.")).toBeVisible();

    // Its heart is how a producer takes a missing favourite out.
    clickAndFlush(
      missing.getAllByRole("button", { name: "Remove missing sound from favourites" })[0],
    );
    await waitFor(() => expect(favouritesPlace()).toHaveTextContent(/^Favourites3/));

    // All sounds is still every sound.
    clickAndFlush(allSounds());
    await waitFor(() => expect(rows()).toEqual(kicks));
  });
});

describe("LibraryModal recently heard (#815)", () => {
  function renderRecent(storage: Storage, analytics?: Analytics) {
    const rendered = render(() => (
      <LibraryModal
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        onInsert={() => undefined}
        addedPackIds={[]}
        analytics={analytics}
        recentlyHeard={createRecentlyHeardStore(storage)}
      />
    ));
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const place = (name: string) =>
      rail.getByRole("button", { name: new RegExp(`^${name}`) });
    return { ...rendered, place };
  }

  const rows = () =>
    within(screen.getByRole("list", { name: "Sounds" }))
      .getAllByRole("button", { name: /^Audition / })
      .map((button) => button.getAttribute("aria-label")?.replace(/^Audition /, ""));
  const hear = (name: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Audition ${name}` }));
  const hearing = () => screen.getByRole("group", { name: "Hearing" });

  it("lists what was heard, last first, and holds still while you listen", async () => {
    const { place } = renderRecent(memoryStorage());
    await screen.findAllByRole("listitem");
    const [a, b, c] = rows() as string[];
    for (const name of [a, b, c]) {
      hear(name);
      await waitFor(() => expect(hearing()).toHaveTextContent(name));
    }

    clickAndFlush(place("Recently heard"));
    await waitFor(() => expect(rows()).toEqual([c, b, a]));

    // Hearing one again moves it to the top, but not under the pointer: the
    // list is the one the place was chosen with until it is chosen again.
    hear(a);
    await waitFor(() => expect(hearing()).toHaveTextContent(a));
    expect(rows()).toEqual([c, b, a]);
    clickAndFlush(place("Recently heard"));
    await waitFor(() => expect(rows()).toEqual([a, c, b]));
  });

  it("survives closing and opening the library again", async () => {
    const storage = memoryStorage();
    const first = renderRecent(storage);
    await screen.findAllByRole("listitem");
    const [a, b] = rows() as string[];
    hear(a);
    hear(b);
    await waitFor(() => expect(hearing()).toHaveTextContent(b));
    first.unmount();

    const second = renderRecent(storage);
    clickAndFlush(second.place("Recently heard"));
    await waitFor(() => expect(rows()).toEqual([b, a]));
  });

  it("leaves out sounds heard through Browse packs' Hear it", async () => {
    const storage = memoryStorage();
    const { place } = renderRecent(storage);
    await screen.findAllByRole("listitem");
    clickAndFlush(place("Browse packs"));
    const packName = FIXTURE_PACK_INDEX_DOC.packs[0].name;
    // The cover's Hear it waits for its pack's manifest, which re-renders it.
    const hearPack = await waitFor(() => {
      const button = screen.getByRole("button", { name: `Hear ${packName}` });
      expect(button).toBeEnabled();
      return button;
    });
    fireEvent.click(hearPack);
    // The run is playing the pack's sounds.
    await screen.findByRole("button", { name: `Stop ${packName}` });

    clickAndFlush(place("Recently heard"));
    expect(await screen.findByText(/^Nothing heard yet/)).toBeVisible();
  });

  it("logs feature_first_use once, however often the place is opened", async () => {
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    const { place } = renderRecent(memoryStorage(), analytics);

    clickAndFlush(place("Recently heard"));
    clickAndFlush(place("All sounds"));
    clickAndFlush(place("Recently heard"));

    const firstUses = transport.events.filter(
      (event) =>
        event.name === "feature_first_use" &&
        event.params.feature === "library_recently_heard",
    );
    expect(firstUses).toHaveLength(1);
  });
});
