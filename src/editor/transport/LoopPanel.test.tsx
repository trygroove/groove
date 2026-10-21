import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import type { WatchPeaks } from "../../instrument/SampleWell";
import LoopPanel from "./LoopPanel";

afterEach(() => cleanup());

/** The drum-machine fixture's audio track and the loop it plays. */
function loopFixture() {
  const project = createDrumMachineFixtureProject();
  const clip = project.clips.find((c) => c.content.kind === "audioLoop");
  if (!clip || clip.content.kind !== "audioLoop") {
    throw new Error("fixture has no audio loop");
  }
  const content = clip.content;
  const asset = project.song.assets.find((a) => a.id === content.assetId) ?? null;
  const track = project.song.tracks.find((t) => t.id === clip.trackId);
  if (!track) throw new Error("fixture loop has no track");
  return { project, clip, asset, track, sourceTempo: content.sourceTempo };
}

/** The value a readout shows above its label. */
function readout(label: string): string | null {
  return screen.getByText(label).previousElementSibling?.textContent ?? null;
}

describe("LoopPanel (#447)", () => {
  it("names the loop and lists its key facts", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => (
      <LoopPanel
        trackName="Break"
        clip={clip}
        asset={asset}
        songTempo={sourceTempo * 1.5}
      />
    ));

    const panel = within(screen.getByRole("region", { name: "Break loop" }));
    expect(readout("Source tempo")).toBe(`${sourceTempo} BPM`);
    expect(readout("Length")).toBe("2 bars");
    expect(readout("Playing at")).toBe(`${sourceTempo * 1.5} BPM`);
    expect(readout("Ratio")).toBe("1.5×");
    expect(panel.getByRole("heading", { name: "Source" })).toBeInTheDocument();
    expect(panel.getByRole("heading", { name: "Stretch" })).toBeInTheDocument();
  });

  it("draws the loop's own waveform over a bar and beat grid", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    const watch = vi.fn<WatchPeaks>((_id, _buckets, onPeaks) => {
      onPeaks(Float32Array.from([1, 0.5, 0.25, 0.75]));
      return () => {};
    });
    render(() => (
      <LoopPanel
        trackName="Break"
        clip={clip}
        asset={asset}
        songTempo={sourceTempo}
        watchPeaks={watch}
      />
    ));
    flush();

    expect(watch).toHaveBeenCalledWith(
      asset?.id,
      expect.any(Number),
      expect.any(Function),
    );
    const well = document.querySelector(".loop-well") as HTMLElement;
    expect(well.querySelector(".sample-well-bars")?.getAttribute("d")).toMatch(/^M/);
    // Two bars of four beats: seven inner lines, one of them the bar line.
    expect(well.querySelectorAll("line.well-grid, line.loop-well-bar")).toHaveLength(8);
    expect(well.querySelectorAll("line.loop-well-bar")).toHaveLength(1);
  });

  it("opens with the instrument header it is given, as its first row", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => (
      <LoopPanel
        trackName="Break"
        clip={clip}
        asset={asset}
        songTempo={sourceTempo}
        header={<header data-testid="header" />}
      />
    ));
    const region = screen.getByRole("region", { name: "Break loop" });
    expect(region.firstElementChild).toBe(screen.getByTestId("header"));
  });

  it("says so when the loop's audio cannot be resolved", () => {
    const { clip, sourceTempo } = loopFixture();
    render(() => (
      <LoopPanel trackName="Break" clip={clip} asset={null} songTempo={sourceTempo} />
    ));
    expect(screen.getAllByText("Loop audio is unavailable").length).toBeGreaterThan(0);
  });

  it("chooses the loop through the same sample slot as the sampler", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    const onBrowse = vi.fn();
    render(() => (
      <LoopPanel
        trackName="Break"
        clip={clip}
        asset={asset}
        songTempo={sourceTempo}
        onBrowse={onBrowse}
      />
    ));
    const slot = screen.getByRole("button", { name: "Loop for Break" });
    expect(slot).toHaveTextContent(asset?.name ?? "");
    slot.click();
    expect(onBrowse).toHaveBeenCalledOnce();
  });

  it("offers the slot on a loop track with no loop yet", () => {
    render(() => (
      <LoopPanel
        trackName="Break"
        clip={null}
        asset={null}
        songTempo={120}
        onBrowse={() => {}}
      />
    ));
    expect(screen.getByRole("button", { name: "Loop for Break" })).toHaveTextContent(
      "No loop loaded",
    );
  });

  it("shows no slot where nothing can open the library", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => (
      <LoopPanel trackName="Break" clip={clip} asset={asset} songTempo={sourceTempo} />
    ));
    expect(screen.queryByRole("button", { name: "Loop for Break" })).toBeNull();
  });
});
