import { describe, expect, it } from "vitest";
import type { Track } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import type { PadId, TrackId } from "../../domain/ids";
import { emptyPadSelection, selectedPadOf, withSelectedPad } from "./padSelection";

function drumTrack(): Track {
  const track = createDrumMachineFixtureProject().song.tracks.find(
    (candidate) => candidate.instrument?.kind === "drumMachine",
  );
  if (!track) throw new Error("no drum machine");
  return track;
}

function padsOf(track: Track) {
  return track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
}

describe("the shared drum-pad selection (#643)", () => {
  it("reads a track's first pad until one is chosen", () => {
    const track = drumTrack();
    const pads = padsOf(track);
    expect(pads.length).toBeGreaterThan(1);
    expect(selectedPadOf(emptyPadSelection, track)).toBe(pads[0].id);
  });

  it("reads the chosen pad, per track", () => {
    const track = drumTrack();
    const pads = padsOf(track);
    const other = "trk_other" as TrackId;
    const selection = withSelectedPad(
      withSelectedPad(emptyPadSelection, track.id, pads[1].id),
      other,
      pads[0].id,
    );
    expect(selectedPadOf(selection, track)).toBe(pads[1].id);
  });

  it("falls back to the first pad when the chosen one is gone", () => {
    const track = drumTrack();
    const pads = padsOf(track);
    const selection = withSelectedPad(emptyPadSelection, track.id, "pad_gone" as PadId);
    expect(selectedPadOf(selection, track)).toBe(pads[0].id);
  });

  it("has no pad for a track without a drum machine, or no track", () => {
    const track = drumTrack();
    expect(selectedPadOf(emptyPadSelection, { ...track, instrument: null })).toBeNull();
    expect(selectedPadOf(emptyPadSelection, null)).toBeNull();
  });

  it("returns the same selection when nothing changes", () => {
    const track = drumTrack();
    const pads = padsOf(track);
    const once = withSelectedPad(emptyPadSelection, track.id, pads[1].id);
    expect(withSelectedPad(once, track.id, pads[1].id)).toBe(once);
  });
});
