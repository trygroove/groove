import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePreviewEngine } from "./__fixtures__/fakePreviewEngine";
import {
  FIXTURE_PACK_INDEX_DOC,
  fixtureFetcher,
  fixturePackManifest,
} from "./__fixtures__/fixtures";
import { FetchClassifiedError, LibraryClient } from "./libraryClient";
import {
  assetStorageRef,
  type LibraryAsset,
  type LibraryAssetType,
  packAssets,
  parsePackManifest,
} from "./manifest";
import SoundsView from "./SoundsView";
import { shelfFamilyOf } from "./shelf";
import type { SoundsKeyAction } from "./soundKeys";
import type { ShelfSlot } from "./useShelf";

afterEach(() => cleanup());

function renderView(
  extra: {
    client?: LibraryClient;
    assetTypes?: readonly LibraryAssetType[];
    query?: string;
    packSlug?: string | null;
    slot?: ShelfSlot;
    songBpm?: number;
    onQueryChange?: (query: string) => void;
  } = {},
) {
  const engine = fakePreviewEngine();
  const onSimilar = vi.fn();
  const onListLabel = vi.fn();
  let press: ((action: SoundsKeyAction) => void) | null = null;
  const [selected, setSelected] = createSignal<LibraryAsset | null>(null);
  render(() => (
    <SoundsView
      client={extra.client ?? new LibraryClient(fixtureFetcher())}
      previewEngine={engine}
      assetTypes={extra.assetTypes}
      query={extra.query}
      packSlug={extra.packSlug}
      slot={extra.slot}
      songBpm={extra.songBpm}
      onQueryChange={extra.onQueryChange}
      keyLabel={(action) => `<${action}>`}
      selected={selected()}
      onSelect={setSelected}
      onSimilar={onSimilar}
      onListLabel={onListLabel}
      onKeys={(handler) => {
        press = handler;
      }}
    />
  ));
  return {
    engine,
    onSimilar,
    onListLabel,
    selected,
    press: (action: SoundsKeyAction) => press?.(action),
  };
}

const rows = () => screen.findAllByRole("listitem");
const names = () =>
  screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".sound-row-name")?.textContent);

/** Every sound name in one committed fixture pack. */
const packNames = (slug: string) =>
  new Set(packAssets(parsePackManifest(fixturePackManifest(slug))).map((a) => a.name));

describe("SoundsView pack scope (LIB-010)", () => {
  it("lists only the opened pack's sounds", async () => {
    const [first, second] = FIXTURE_PACK_INDEX_DOC.packs;
    renderView({ packSlug: second.slug });

    await rows();
    const inPack = packNames(second.slug);
    expect(names().every((name) => inPack.has(name ?? ""))).toBe(true);
    const onlyInFirst = [...packNames(first.slug)].filter((name) => !inPack.has(name));
    expect(names().some((name) => onlyInFirst.includes(name ?? ""))).toBe(false);
  });

  it("selects and auditions from the scoped list like any other", async () => {
    const [, second] = FIXTURE_PACK_INDEX_DOC.packs;
    const { engine, selected } = renderView({ packSlug: second.slug });
    const [row] = await rows();

    fireEvent.click(row.querySelector(".sound-row-main") as HTMLElement);

    await waitFor(() => expect(engine.starts).toHaveLength(1));
    expect(selected()?.packSlug).toBe(second.slug);
  });
});

describe("SoundsView loading (UI-002)", () => {
  it("shows the loader while the library is still loading", async () => {
    renderView({ client: new LibraryClient(() => new Promise(() => undefined)) });
    expect(await screen.findByText("Loading library")).toBeInTheDocument();
  });

  it("opens straight on the list when the library has already loaded", async () => {
    const client = new LibraryClient(fixtureFetcher());
    renderView({ client });
    await rows();
    cleanup();

    // A second visit with the same client: the loader never mounts.
    const shown = vi.fn();
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("Loading library")) shown();
    });
    observer.observe(document.body, { subtree: true, childList: true });
    renderView({ client });
    await rows();
    await new Promise((resolve) => setTimeout(resolve, 10));
    observer.disconnect();
    expect(shown).not.toHaveBeenCalled();
  });
});

describe("SoundsView", () => {
  it("lists every pack's sounds as compact rows", async () => {
    renderView();

    const items = await rows();
    expect(items.length).toBeGreaterThan(4);
    expect(items[0].querySelector(".sound-row-meta")?.textContent).toMatch(/ · /);
    expect(items[0].querySelector("svg.mini-waveform")).not.toBeNull();
  });

  it("selects and auditions a row on click, and shows it as selected", async () => {
    const { engine, selected } = renderView();
    const [first] = await rows();

    fireEvent.click(first.querySelector(".sound-row-main") as HTMLElement);

    await waitFor(() => expect(engine.starts).toHaveLength(1));
    expect(selected()?.name).toBe(engine.starts[0].asset.name);
    expect(first).toHaveClass("sound-row-selected");
  });

  it("steps with the arrow keys, auditioning each, clamped at both ends", async () => {
    const { engine, press } = renderView();
    await rows();

    press("library.select_next");
    await waitFor(() => expect(engine.starts).toHaveLength(1));
    expect(engine.starts[0].asset.name).toBe(names()[0]);
    press("library.select_next");
    await waitFor(() => expect(engine.starts).toHaveLength(2));
    expect(engine.starts[1].asset.name).toBe(names()[1]);
    press("library.select_previous");
    await waitFor(() => expect(engine.starts).toHaveLength(3));
    expect(engine.starts[2].asset.name).toBe(names()[0]);
    // Already at the first: nothing more to hear.
    press("library.select_previous");
    expect(engine.starts).toHaveLength(3);
  });

  it("moves focus to the selected row as the arrow keys step (#880)", async () => {
    const { engine, press } = renderView();
    const items = await rows();

    press("library.select_next");
    await waitFor(() => expect(engine.starts).toHaveLength(1));
    press("library.select_next");
    await waitFor(() => expect(engine.starts).toHaveLength(2));
    await waitFor(() =>
      expect(document.activeElement).toBe(items[1].querySelector(".sound-row-main")),
    );
    press("library.select_previous");
    await waitFor(() =>
      expect(document.activeElement).toBe(items[0].querySelector(".sound-row-main")),
    );
  });

  it("is one Tab stop: the selected row, or the first with none selected (#880)", async () => {
    const { engine, press } = renderView();
    const items = await rows();
    const tabStops = () =>
      Array.from(
        screen.getByRole("list", { name: "Sounds" }).querySelectorAll("button"),
      ).filter((button) => button.tabIndex >= 0);

    expect(tabStops()).toEqual([items[0].querySelector(".sound-row-main")]);
    press("library.select_next");
    await waitFor(() => expect(engine.starts).toHaveLength(1));
    press("library.select_next");
    await waitFor(() =>
      expect(tabStops()).toEqual([items[1].querySelector(".sound-row-main")]),
    );
  });

  it("re-auditions the selected sound on Space, and ignores it with nothing selected", async () => {
    const { engine, press } = renderView();
    const [first] = await rows();

    press("library.audition");
    expect(engine.starts).toHaveLength(0);

    fireEvent.click(first.querySelector(".sound-row-main") as HTMLElement);
    await waitFor(() => expect(engine.starts).toHaveLength(1));
    press("library.audition");
    await waitFor(() => expect(engine.starts).toHaveLength(2));
    expect(engine.starts[1].asset.name).toBe(engine.starts[0].asset.name);
  });

  it("asks for similar sounds on S, for the selected sound only", async () => {
    const { onSimilar, press, selected } = renderView();
    const [first] = await rows();

    press("library.similar");
    expect(onSimilar).not.toHaveBeenCalled();

    fireEvent.click(first.querySelector(".sound-row-main") as HTMLElement);
    await waitFor(() => expect(selected()).not.toBeNull());
    press("library.similar");
    expect(onSimilar).toHaveBeenCalledWith(selected());
  });

  it("shows only the asked-for asset types", async () => {
    renderView({ assetTypes: ["loop"] });

    for (const item of await rows()) {
      expect(item.querySelector(".sound-row-length")?.textContent).toMatch(/BPM|bar/);
    }
  });

  it("narrows to what the header search matches", async () => {
    renderView({ query: "kick" });

    const items = await rows();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.textContent?.toLowerCase()).toContain("kick");
  });

  it("says when nothing matches, and keeps the shelf at zero", async () => {
    renderView({ query: "zzzz-no-such-sound" });

    expect(await screen.findByText("No sounds match these filters.")).toBeVisible();
    expect(screen.getByRole("tab", { name: /^Drums/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "All drums 0" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Sounds" })).toBeNull();
  });

  it("says why the library is missing, and retries", async () => {
    let attempt = 0;
    const client = new LibraryClient(async (path) => {
      attempt++;
      if (attempt === 1) throw new FetchClassifiedError("network", "offline");
      return fixtureFetcher()(path);
    });
    renderView({ client });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("sounds-retry");
    fireEvent.click(retry);

    expect((await rows()).length).toBeGreaterThan(0);
  });
});

async function libraryAssets(): Promise<LibraryAsset[]> {
  const client = new LibraryClient(fixtureFetcher());
  const loaded = await Promise.all(
    (await client.loadIndex()).map((pack) => client.loadPack(pack)),
  );
  return loaded.flatMap((result) => (result.ok ? [...result.assets] : []));
}

const tabs = () => screen.getAllByRole("tab");
const selectedTab = () =>
  tabs().find((tab) => tab.getAttribute("aria-selected") === "true");
const chips = () => document.querySelectorAll<HTMLElement>(".shelf-chips .shelf-chip");
const pressedChip = () =>
  [...chips()].find((chip) => chip.getAttribute("aria-pressed") === "true");

describe("SoundsView shelf", () => {
  it("opens where the slot says: a drum pad on its sound's role, the sampler on Tonal, a loop track on Loops", async () => {
    const assets = await libraryAssets();
    const held = assets.find((a) => a.type === "one-shot" && a.family === "drums");
    if (!held?.storageKey) throw new Error("fixture library has no drum one-shot");
    const ref = assetStorageRef(held.storageKey);

    cleanup();
    renderView({ slot: { kind: "drum-pad", ref } });
    await rows();
    expect(selectedTab()).toHaveTextContent(/^Drums/);
    expect(pressedChip()).toHaveAccessibleName(/^Kick/);

    cleanup();
    renderView({ slot: { kind: "drum-pad", ref: null } });
    await rows();
    expect(selectedTab()).toHaveTextContent(/^Drums/);
    expect(pressedChip()).toHaveAccessibleName(/^All drums \d+$/);

    cleanup();
    renderView({ slot: { kind: "sampler" } });
    await rows();
    expect(selectedTab()).toHaveTextContent(/^Tonal/);

    cleanup();
    renderView({ slot: { kind: "loop-track" } });
    await rows();
    expect(selectedTab()).toHaveTextContent(/^Loops/);
  });

  it("names the list in view for the way back to it: a role's plural, All <family>, or the pack", async () => {
    const assets = await libraryAssets();
    const held = assets.find((a) => a.type === "one-shot" && a.role === "kick");
    if (!held?.storageKey) throw new Error("fixture library has no kick");

    cleanup();
    const kicks = renderView({
      slot: { kind: "drum-pad", ref: assetStorageRef(held.storageKey) },
    });
    await waitFor(() => expect(kicks.onListLabel).toHaveBeenLastCalledWith("Kicks"));

    cleanup();
    const all = renderView({ slot: { kind: "drum-pad", ref: null } });
    await waitFor(() => expect(all.onListLabel).toHaveBeenLastCalledWith("All drums"));

    cleanup();
    const pack = renderView({ packSlug: held.packSlug });
    await waitFor(() => expect(pack.onListLabel).toHaveBeenLastCalledWith(held.packName));
  });

  it("shows only families and categories that have sounds, with counts", async () => {
    renderView({ assetTypes: ["loop"] });
    await rows();

    expect(tabs().map((tab) => tab.textContent)).toEqual([
      expect.stringMatching(/^Loops \d+$/),
    ]);
    for (const chip of chips()) expect(chip.textContent).toMatch(/\d/);
  });

  it("switches the list with a family tile and a category chip", async () => {
    renderView();
    await rows();

    fireEvent.click(screen.getByRole("tab", { name: /^Bass/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Bass/));
    const bass = names();
    expect(bass.length).toBeGreaterThan(0);

    fireEvent.click(chips()[1]);
    await waitFor(() => expect(chips()[1]).toHaveAttribute("aria-pressed", "true"));
    expect(names().length).toBeLessThanOrEqual(bass.length);
  });

  it("badges All with its registry key, and no category with a digit (UI-002)", async () => {
    renderView();
    await rows();

    const [all, first] = [...chips()];
    expect(all.querySelector("kbd")?.textContent).toBe("<library.pick_all>");
    expect(first.querySelector("kbd")).toBeNull();
  });

  it("picks categories and families from the keys", async () => {
    const { press } = renderView({ slot: { kind: "loop-track" } });
    await rows();

    press("library.category_next");
    await waitFor(() => expect(chips()[1]).toHaveAttribute("aria-pressed", "true"));
    press("library.category_next");
    await waitFor(() => expect(chips()[2]).toHaveAttribute("aria-pressed", "true"));
    press("library.category_next");
    await waitFor(() => expect(chips()[3]).toHaveAttribute("aria-pressed", "true"));
    press("library.category_previous");
    await waitFor(() => expect(chips()[2]).toHaveAttribute("aria-pressed", "true"));
    press("library.pick_all");
    await waitFor(() => expect(chips()[0]).toHaveAttribute("aria-pressed", "true"));
    // Previous from All holds.
    press("library.category_previous");
    expect(chips()[0]).toHaveAttribute("aria-pressed", "true");

    // Loops is the last family: Next holds, Previous steps back and Next returns.
    const before = selectedTab()?.textContent;
    press("library.family_next");
    expect(selectedTab()?.textContent).toBe(before);
    press("library.family_previous");
    await waitFor(() => expect(selectedTab()?.textContent).not.toBe(before));
    press("library.family_next");
    await waitFor(() => expect(selectedTab()?.textContent).toBe(before));
  });
});

const count = () =>
  Number(document.querySelector(".filter-count")?.textContent?.match(/\d+/)?.[0]);
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const picker = () => document.querySelector(".filter-pick") as HTMLElement;

/**
 * {@link fixtureFetcher}, except the texture pack's last one-shot is filed
 * under FX, so the library has all five one-shot families (the committed
 * fixture has no FX sound of its own).
 */
function fiveFamilyFetcher() {
  const base = fixtureFetcher();
  return async (path: string) => {
    const doc = (await base(path)) as {
      assets?: { type: string; family: string; role: string }[];
    };
    if (!Array.isArray(doc.assets) || !doc.assets.some((a) => a.family === "texture"))
      return doc;
    const last = doc.assets.findLastIndex((a) => a.type === "one-shot");
    return {
      ...doc,
      assets: doc.assets.map((asset, i) =>
        i === last ? { ...asset, family: "fx", role: "impact" } : asset,
      ),
    };
  };
}

describe("SoundsView family tabs during a search (#878)", () => {
  const familyTabs = () =>
    tabs().map((tab) => [
      tab.querySelector(".shelf-family-name")?.textContent,
      tab.querySelector(".shelf-family-count")?.textContent,
    ]);

  it("keeps every family's tab, with its match count, when the search matches one family", async () => {
    renderView({
      client: new LibraryClient(fiveFamilyFetcher()),
      assetTypes: ["one-shot"],
      query: "kick",
    });
    const kicks = (await rows()).length;
    expect(kicks).toBeGreaterThan(0);

    expect(familyTabs()).toEqual([
      ["Drums", String(kicks)],
      ["Bass", "0"],
      ["Tonal", "0"],
      ["Texture", "0"],
      ["FX", "0"],
    ]);
  });

  it("selects a 0-count tab on click and shows the empty state as it is", async () => {
    renderView({
      client: new LibraryClient(fiveFamilyFetcher()),
      assetTypes: ["one-shot"],
      query: "kick",
    });
    await rows();

    fireEvent.click(screen.getByRole("tab", { name: /^Bass/ }));

    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Bass/));
    expect(screen.getByText("No sounds match these filters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear the filters" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Sounds" })).toBeNull();
    expect(tabs()).toHaveLength(5);
  });

  it("keeps every tab at zero when nothing matches", async () => {
    renderView({
      client: new LibraryClient(fiveFamilyFetcher()),
      assetTypes: ["one-shot"],
      query: "zzzz-no-such-sound",
    });

    expect(await screen.findByText("No sounds match these filters.")).toBeVisible();
    expect(familyTabs()).toEqual([
      ["Drums", "0"],
      ["Bass", "0"],
      ["Tonal", "0"],
      ["Texture", "0"],
      ["FX", "0"],
    ]);
  });

  it("keeps every tab the pack has inside a pack", async () => {
    const assets = await libraryAssets();
    const familiesOf = (slug: string) =>
      new Set(
        assets
          .filter((a) => a.packSlug === slug)
          .map(shelfFamilyOf)
          .filter((family) => family !== null),
      );
    const slug = FIXTURE_PACK_INDEX_DOC.packs
      .map((p) => p.slug)
      .find((s) => familiesOf(s).size > 1 && familiesOf(s).has("drums"));
    if (!slug) throw new Error("No fixture pack spans drums and another family");
    renderView({ packSlug: slug, query: "kick" });
    const kicks = (await rows()).length;

    expect(tabs()).toHaveLength(familiesOf(slug).size);
    expect(screen.getByRole("tab", { name: /^Drums/ })).toHaveTextContent(
      new RegExp(`${kicks}$`),
    );
    for (const tab of tabs().filter((t) => !/^Drums/.test(t.textContent ?? "")))
      expect(tab).toHaveTextContent(/ 0$/);
  });
});

describe("SoundsView entering a pack (#994)", () => {
  it("settles the family onto the pack's own when the search matches nothing", async () => {
    const assets = await libraryAssets();
    const familiesOf = (slug: string) =>
      new Set(
        assets
          .filter((a) => a.packSlug === slug && a.type === "one-shot")
          .map(shelfFamilyOf),
      );
    const drumsOnly = FIXTURE_PACK_INDEX_DOC.packs
      .map((p) => p.slug)
      .find((s) => familiesOf(s).size === 1 && familiesOf(s).has("drums"));
    if (!drumsOnly) throw new Error("No fixture pack holds drum one-shots only");

    const [packSlug, setPackSlug] = createSignal<string | null>(null);
    render(() => (
      <SoundsView
        client={new LibraryClient(fixtureFetcher())}
        previewEngine={fakePreviewEngine()}
        assetTypes={["one-shot"]}
        query="zzzzzzzz"
        packSlug={packSlug()}
        slot={{ kind: "drum-pad", ref: null }}
        keyLabel={(action) => `<${action}>`}
        selected={null}
        onSelect={() => {}}
        onSimilar={() => {}}
        onListLabel={() => {}}
        onKeys={() => {}}
      />
    ));
    await screen.findByText("No sounds match these filters.");
    fireEvent.click(screen.getByRole("tab", { name: /^Bass/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Bass/));

    setPackSlug(drumsOnly);

    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(selectedTab()).toHaveTextContent(/^Drums/);
    expect(pressedChip()).toHaveAccessibleName(/^All drums 0$/);
    expect(screen.queryByText(/All bass/)).toBeNull();
  });
});

describe("SoundsView filters", () => {
  it("shows the live count, which follows the shelf", async () => {
    renderView();
    const listed = (await rows()).length;
    expect(count()).toBe(listed);
    expect(document.querySelector(".filter-count")).toHaveTextContent(`${listed} sounds`);
  });

  it("filters by genre from a menu that counts them, and the G key opens it", async () => {
    const { press } = renderView();
    const before = (await rows()).length;
    expect(button(/^Any genre/)).toHaveAttribute("aria-expanded", "false");

    press("library.genre_menu");
    const menu = await screen.findByRole("group", { name: "Genres" });
    expect(menu).toBeVisible();
    const options = menu.querySelectorAll("input");
    expect(options.length).toBeGreaterThan(1);
    // Labelled in words ("Electronic pop"), not by the manifest's slug.
    for (const option of options) {
      expect(option.closest("label")?.textContent).toMatch(/^[A-Z][a-z]*( [a-z]+)* \d+$/);
    }
    fireEvent.click(options[options.length - 1]);

    await waitFor(() => expect(count()).toBeLessThan(before));
    // The picker names the genre now, and turns white to say a filter is set.
    expect(picker()).not.toHaveAccessibleName(/^Any genre/);
    expect(picker()).toHaveClass("filter-pick-set");
    press("library.genre_menu");
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Genres" })).toBeNull(),
    );
  });

  // GRV-165: G used to leave focus on the header, so Down walked the list behind.
  it("moves focus into the genre menu on G, and Up and Down walk its genres", async () => {
    const { press, selected } = renderView();
    await rows();

    press("library.genre_menu");
    const menu = await screen.findByRole("group", { name: "Genres" });
    const options = [...menu.querySelectorAll("input")];
    await waitFor(() => expect(document.activeElement).toBe(options[0]));

    press("library.select_next");
    expect(document.activeElement).toBe(options[1]);
    press("library.select_previous");
    expect(document.activeElement).toBe(options[0]);
    // The list behind the menu is not driven by the arrows.
    expect(selected()).toBeNull();
  });

  // #890: ticking a genre re-counts the menu; the row must survive that, or
  // focus drops to <body> and the next Space or Enter misses the checkbox.
  it("keeps focus on a genre checkbox after it toggles, on and off again", async () => {
    renderView();
    const before = (await rows()).length;
    fireEvent.click(picker());
    const menu = await screen.findByRole("group", { name: "Genres" });
    const checkbox = menu.querySelectorAll("input")[0];
    checkbox.focus();

    fireEvent.click(checkbox);
    await waitFor(() => expect(count()).toBeLessThan(before));
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => expect(count()).toBe(before));
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("clears every genre from the menu's Any genre row, and closes it", async () => {
    renderView();
    const before = (await rows()).length;
    fireEvent.click(picker());
    const menu = await screen.findByRole("group", { name: "Genres" });
    const options = menu.querySelectorAll("input");
    fireEvent.click(options[0]);
    fireEvent.click(options[options.length - 1]);
    await waitFor(() => expect(picker()).toHaveClass("filter-pick-set"));

    fireEvent.click(within(menu).getByRole("button", { name: "Any genre" }));

    await waitFor(() => expect(count()).toBe(before));
    expect(picker()).toHaveAccessibleName(/^Any genre/);
    expect(picker()).not.toHaveClass("filter-pick-set");
    expect(screen.queryByRole("group", { name: "Genres" })).toBeNull();
  });

  it("labels the Tempo and Bars groups, with short segments named in full", async () => {
    renderView({ slot: { kind: "loop-track" }, songBpm: 96 });
    await rows();

    const tempo = screen.getByRole("group", { name: "Tempo" });
    expect(tempo.querySelector("legend")).toHaveTextContent("Tempo");
    expect(within(tempo).getByRole("button", { name: "Any tempo" })).toHaveTextContent(
      /^Any$/,
    );
    const bars = screen.getByRole("group", { name: "Bars" });
    expect(within(bars).getByRole("button", { name: "4 bars" })).toHaveTextContent(/^4$/);
    expect(within(bars).getByRole("button", { name: "1 bar" })).toHaveTextContent(/^1$/);
  });

  it("offers Tempo and Bars under Loops only, and the T key toggles near and any", async () => {
    const { press } = renderView({ slot: { kind: "loop-track" }, songBpm: 96 });
    await rows();

    // #823: loops open near the song tempo, the ones that stretch well.
    expect(screen.getByRole("group", { name: "Bars" })).toBeVisible();
    expect(button(/^Near 96/)).toHaveAttribute("aria-pressed", "true");
    const near = count();
    fireEvent.click(button(/^Any tempo/));
    await waitFor(() => expect(count()).toBeGreaterThan(near));
    const all = count();
    press("library.loop_tempo");
    await waitFor(() => expect(count()).toBe(near));
    press("library.loop_tempo");
    await waitFor(() => expect(count()).toBe(all));
    expect(button(/^Any tempo/)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("2 bars"));
    await waitFor(() => expect(count()).toBeLessThan(all));
    fireEvent.click(button("Any bars"));
    await waitFor(() => expect(count()).toBe(all));

    fireEvent.click(screen.getByRole("tab", { name: /^Drums/ }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Bars" })).toBeNull());
  });

  it("offers to clear the filters when nothing is left, and clears the search too", async () => {
    const onQueryChange = vi.fn();
    renderView({ assetTypes: ["loop"], slot: { kind: "loop-track" }, onQueryChange });
    await rows();

    fireEvent.click(button("8 bars"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear the filters" }));

    await waitFor(() => expect(count()).toBeGreaterThan(0));
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(button("Any bars")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("SoundsView search jumps and shuffle", () => {
  it("offers a role the search names as a jump, which opens it and clears the search", async () => {
    const onQueryChange = vi.fn();
    renderView({ query: "kick", onQueryChange });
    await rows();

    expect(document.querySelector(".role-jumps")).toHaveTextContent(/^Categories/);
    fireEvent.click(await screen.findByRole("button", { name: "Kick \u2192" }));

    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(selectedTab()).toHaveTextContent(/^Drums/);
    await waitFor(() => expect(pressedChip()).toHaveAccessibleName(/^Kick/));
  });

  it("offers no jump without a query", async () => {
    renderView();
    await rows();

    expect(document.querySelector(".role-jumps")).toBeNull();
  });

  it("shuffles to a random sound from the list in view, and audition it", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { engine, press } = renderView();
    await rows();

    press("library.shuffle");

    await waitFor(() => expect(engine.starts).toHaveLength(1));
    expect(engine.starts[0].asset.name).toBe(names().at(-1));
    random.mockRestore();
  });

  it("shuffles nothing from an empty list", async () => {
    const { engine, press } = renderView({ query: "zzzz-no-such-sound" });
    await screen.findByText("No sounds match these filters.");

    press("library.shuffle");

    expect(engine.starts).toHaveLength(0);
  });
});

describe("SoundsView failures", () => {
  it("names an unavailable pack while the others keep listing, and retries it", async () => {
    let failing = true;
    const client = new LibraryClient(async (path) => {
      if (failing && path.includes(`/${FIXTURE_PACK_INDEX_DOC.packs[0].slug}/`)) {
        throw new FetchClassifiedError("network", "offline");
      }
      return fixtureFetcher()(path);
    });
    renderView({ client });

    expect(await screen.findByText(/unavailable/)).toBeVisible();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect((await rows()).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText(/unavailable/)).toBeNull());
  });

  it("shows a per-row error when a preview fails, without blocking the others", async () => {
    const { engine } = renderView();
    const [first, second] = await rows();
    engine.failNextWith("network");

    fireEvent.click(first.querySelector(".sound-row-main") as HTMLElement);
    await waitFor(() =>
      expect(first.querySelector(".sound-row-meta")).toHaveTextContent(
        /connection|load/i,
      ),
    );

    fireEvent.click(second.querySelector(".sound-row-main") as HTMLElement);
    await waitFor(() => expect(engine.starts).toHaveLength(1));
  });
});
