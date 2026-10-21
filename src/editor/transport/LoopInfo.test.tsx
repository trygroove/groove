import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import LoopInfo, { loopStretchRatio } from "./LoopInfo";

afterEach(() => cleanup());

/** The drum-machine fixture carries a two-bar audio loop authored at its
 * song tempo; grab that clip and its resolved asset. */
function loopFixture() {
  const project = createDrumMachineFixtureProject();
  const clip = project.clips.find((c) => c.content.kind === "audioLoop");
  if (!clip || clip.content.kind !== "audioLoop") {
    throw new Error("fixture has no audio loop");
  }
  const content = clip.content;
  const asset = project.song.assets.find((a) => a.id === content.assetId) ?? null;
  return { project, clip, asset, sourceTempo: content.sourceTempo };
}

describe("loopStretchRatio", () => {
  it("is 1 when the song plays at the loop's source tempo", () => {
    expect(loopStretchRatio(120, 120)).toBe(1);
  });

  it("is 2 at double the source tempo (the loop takes half the time)", () => {
    expect(loopStretchRatio(120, 240)).toBeCloseTo(2);
  });

  it("is 0.5 at half the source tempo (the loop takes twice the time)", () => {
    expect(loopStretchRatio(120, 60)).toBeCloseTo(0.5);
  });
});

describe("LoopInfo", () => {
  it("labels the clip a tempo-labelled loop and shows its source tempo", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={asset} songTempo={sourceTempo} />);

    expect(screen.getByText(/tempo-labelled loop/i)).toBeInTheDocument();
    // "Source tempo" is a labelled fact; its value sits in the dd after it.
    const sourceTerm = screen.getByText("Source tempo");
    expect(sourceTerm.nextElementSibling).toHaveTextContent(`${sourceTempo} BPM`);
  });

  it("documents the time-stretch behaviour honestly", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={asset} songTempo={sourceTempo * 2} />);

    // The honesty requirement: the UI names the mechanism (time-stretch),
    // says pitch is preserved, and does not hide what stretching costs.
    expect(screen.getByText(/time-stretch/i)).toBeInTheDocument();
    expect(screen.getByText(/preserves pitch/i)).toBeInTheDocument();
    expect(screen.getByText(/softens transients/i)).toBeInTheDocument();
  });

  it("says the loop is played untouched at its source tempo", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={asset} songTempo={sourceTempo} />);

    expect(screen.getByText(/no stretching at all/i)).toBeInTheDocument();
  });

  it("reports the live stretch ratio when the song tempo differs from the source", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={asset} songTempo={sourceTempo * 2} />);

    // Double tempo => the loop is squeezed into half the time.
    const stretchTerm = screen.getByText("Stretch");
    expect(stretchTerm.nextElementSibling).toHaveTextContent("2×");
    expect(screen.getByText(/stretched 2×/i)).toBeInTheDocument();
  });

  it("distinguishes a loop from a pitched one-shot in copy", () => {
    const { clip, asset, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={asset} songTempo={sourceTempo} />);

    expect(screen.getByText(/pitched one-shot/i)).toBeInTheDocument();
  });

  it("surfaces a missing loop asset rather than rendering silence", () => {
    const { clip, sourceTempo } = loopFixture();
    render(() => <LoopInfo clip={clip} asset={null} songTempo={sourceTempo} />);

    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });

  it("renders nothing for a note clip", () => {
    const project = createDrumMachineFixtureProject();
    const noteClip = project.clips.find((c) => c.content.kind === "notes");
    if (!noteClip) throw new Error("fixture has no note clip");
    const asset = project.song.assets[0] as Asset;
    const { container } = render(() => (
      <LoopInfo clip={noteClip} asset={asset} songTempo={120} />
    ));

    expect(container.querySelector(".loop-info")).toBeNull();
  });
});
