import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureFetcher } from "./__fixtures__/fixtures";
import { readLibrarySampleDrag } from "./assetDrag";
import { LibraryClient } from "./libraryClient";
import type { LibraryAsset } from "./manifest";
import SoundRow, { lengthLabel } from "./SoundRow";

afterEach(() => cleanup());

async function fixtureAssets(): Promise<LibraryAsset[]> {
  const client = new LibraryClient(fixtureFetcher());
  const packs = await client.loadIndex();
  const loaded = await Promise.all(packs.map((pack) => client.loadPack(pack)));
  return loaded.flatMap((result) => (result.ok ? [...result.assets] : []));
}

function renderRow(
  asset: LibraryAsset,
  extra: Partial<Parameters<typeof SoundRow>[0]> = {},
) {
  const onSelect = vi.fn();
  const onSimilar = vi.fn();
  render(() => (
    <ul>
      <SoundRow
        asset={asset}
        selected={false}
        tabbable={false}
        playing={false}
        error={null}
        onSelect={onSelect}
        onSimilar={onSimilar}
        {...extra}
      />
    </ul>
  ));
  return { onSelect, onSimilar };
}

describe("SoundRow", () => {
  it("masks a personal sound's names for replay, and leaves a factory sound's alone (GRV-75)", async () => {
    const asset = (await fixtureAssets())[0];
    renderRow(asset);
    renderRow({ ...asset, id: "ast_mine", name: "my kick", licence: "user-owned" });

    const [factory, personal] = screen.getAllByRole("listitem");
    expect(factory.querySelector(".sound-row-name")).not.toHaveClass("ph-mask");
    expect(personal.querySelector(".sound-row-name")).toHaveClass("ph-mask");
    expect(personal.querySelector(".sound-row-meta")).toHaveClass("ph-mask");
  });

  it("slots the sound's own controls in before the heart (GRV-75)", async () => {
    const asset = (await fixtureAssets())[0];
    renderRow(asset, {
      actions: (
        <button type="button" aria-label="Rename sound">
          R
        </button>
      ),
    });

    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("sound-row-with-actions");
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      `Audition ${asset.name}`,
      "Rename sound",
      `Favourite ${asset.name}`,
      `Sounds like ${asset.name}`,
    ]);
  });

  it("names the sound, and says its pack, role and length", async () => {
    const asset = (await fixtureAssets()).find(
      (a) => a.type === "one-shot",
    ) as LibraryAsset;
    renderRow(asset);

    expect(screen.getByRole("button", { name: `Audition ${asset.name}` })).toBeVisible();
    expect(screen.getByRole("listitem")).toHaveTextContent(asset.packName);
    expect(screen.getByRole("listitem")).toHaveTextContent(lengthLabel(asset));
    expect(
      screen.getByRole("listitem").querySelector("svg.mini-waveform"),
    ).not.toBeNull();
  });

  it("puts the character tags in their own column, joined with a dot", async () => {
    const asset = (await fixtureAssets()).find(
      (a) => a.characters.length >= 2,
    ) as LibraryAsset;
    renderRow(asset);

    const row = screen.getByRole("listitem");
    expect(row.querySelector(".sound-row-tags")).toHaveTextContent(
      `${asset.characters[0]} · ${asset.characters[1]}`,
    );
    expect(row.querySelector(".sound-row-meta")).not.toHaveTextContent(
      asset.characters[0],
    );
  });

  it("marks a loop row, whose length column is the wider one", () => {
    const loop = { type: "loop", bpm: 124, bars: 4 } as LibraryAsset;
    renderRow({
      ...loop,
      name: "Groove",
      packName: "Pack",
      role: "full-loop",
      characters: [],
      peaks: null,
    } as LibraryAsset);

    expect(screen.getByRole("listitem")).toHaveClass("sound-row-loop");
    expect(screen.getByRole("listitem")).toHaveTextContent("124 BPM · 4 bars");
  });

  it("selects on click, opens similar sounds from its icon, and has an inert heart without favourites", async () => {
    const [asset] = await fixtureAssets();
    const { onSelect, onSimilar } = renderRow(asset);

    fireEvent.click(screen.getByRole("button", { name: `Audition ${asset.name}` }));
    fireEvent.click(screen.getByRole("button", { name: `Sounds like ${asset.name}` }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSimilar).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: `Favourite ${asset.name}` }),
    ).toBeDisabled();
  });

  it("toggles a favourite from its heart, pressed and filled while it is one (#815)", async () => {
    const [asset] = await fixtureAssets();
    const onFavourite = vi.fn();
    renderRow(asset, { favourite: true, onFavourite });

    const heart = screen.getByRole("button", { name: `Favourite ${asset.name}` });
    expect(heart).toBeEnabled();
    expect(heart).toHaveAttribute("aria-pressed", "true");
    expect(heart).toHaveClass("sound-row-favourite");
    fireEvent.click(heart);
    expect(onFavourite).toHaveBeenCalledTimes(1);
  });

  it("leaves a heart unpressed for a sound that is not a favourite", async () => {
    const [asset] = await fixtureAssets();
    renderRow(asset, { favourite: false, onFavourite: vi.fn() });

    const heart = screen.getByRole("button", { name: `Favourite ${asset.name}` });
    expect(heart).toHaveAttribute("aria-pressed", "false");
    expect(heart).not.toHaveClass("sound-row-favourite");
  });

  it("marks the selected row, draws its waveform in the track colour, and reports errors", async () => {
    const [asset] = await fixtureAssets();
    renderRow(asset, { selected: true, color: "#123456", error: "network" });

    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("sound-row-selected");
    expect(row.style.getPropertyValue("--waveform-fill")).toBe("#123456");
    expect(
      screen.getByRole("button", { name: `Audition ${asset.name}` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(row).toHaveTextContent(/connection|load/i);
  });

  it("labels a loop by tempo and bars", () => {
    const loop = { type: "loop", bpm: 120, bars: 4 } as LibraryAsset;
    expect(lengthLabel(loop)).toBe("120 BPM · 4 bars");
    expect(lengthLabel({ ...loop, bars: 1 })).toBe("120 BPM · 1 bar");
    expect(lengthLabel({ type: "one-shot", durationSeconds: 0.5 } as LibraryAsset)).toBe(
      "0.50 s",
    );
  });
});

describe("SoundRow drag", () => {
  it("puts the sound on the drag when the row is dragged (#225)", async () => {
    const asset = (await fixtureAssets()).find(
      (a) => a.type === "one-shot",
    ) as LibraryAsset;
    renderRow(asset);
    const row = screen.getByRole("listitem");
    expect(row.getAttribute("draggable")).toBe("true");

    const data = new Map<string, string>();
    const dataTransfer = {
      get types() {
        return [...data.keys()];
      },
      getData: (format: string) => data.get(format) ?? "",
      setData: (format: string, value: string) => {
        data.set(format, value);
      },
    };
    fireEvent.dragStart(row, { dataTransfer });

    const sample = readLibrarySampleDrag(dataTransfer);
    expect(sample?.name).toBe(asset.name);
    expect(sample?.packId).toMatch(/^pak_/);
  });
});
