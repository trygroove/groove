import { describe, expect, it } from "vitest";
import type { Project, Track } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import type { PadId } from "../../domain/ids";
import {
  libraryAim,
  sameTarget,
  targetAssetTypes,
  targetPath,
  targetSound,
} from "./libraryTarget";

function drumMachine(project: Project) {
  const [track] = project.song.tracks;
  if (track.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
  return { track, pads: track.instrument.pads };
}

const loopTrack = (project: Project): Track => {
  const found = project.song.tracks.find((track) => track.type === "audio");
  if (!found) throw new Error("no loop track");
  return found;
};

describe("libraryAim (UI-002)", () => {
  it("aims at a drum machine's selected pad", () => {
    const { track, pads } = drumMachine(createDrumMachineFixtureProject());
    expect(libraryAim(track, pads[1].id, false)).toEqual({
      kind: "target",
      target: { kind: "pad", trackId: track.id, padId: pads[1].id },
    });
  });

  it("aims at a new pad for the Sequence view's [+ Pad], on a drum machine only (#947)", () => {
    const project = createDrumMachineFixtureProject();
    const { track, pads } = drumMachine(project);
    const target = { kind: "new-pad", trackId: track.id } as const;
    expect(libraryAim(track, pads[1].id, false, true)).toEqual({
      kind: "target",
      target,
    });
    expect(targetAssetTypes(target)).toEqual(["one-shot"]);
    expect(targetSound(project, target)).toBeNull();
    expect(targetPath(project, target)).toBe(`${track.name} › Drum machine › New pad`);
    const sampler = createSliceFixtureProject().song.tracks[0];
    expect(libraryAim(sampler, null, false, true)).toEqual({
      kind: "target",
      target: { kind: "sampler", trackId: sampler.id },
    });
  });

  it("aims at a sampler's slot, and a loop track's loop", () => {
    const sampler = createSliceFixtureProject().song.tracks[0];
    expect(libraryAim(sampler, null, false)).toEqual({
      kind: "target",
      target: { kind: "sampler", trackId: sampler.id },
    });
    const loop = loopTrack(createDrumMachineFixtureProject());
    expect(libraryAim(loop, null, false)).toEqual({
      kind: "target",
      target: { kind: "loop", trackId: loop.id },
    });
  });

  it("says why there is nothing to aim at: a synth, no pad, or no track", () => {
    const synth = createPianoRollFixtureProject().song.tracks[0];
    expect(synth.instrument?.kind).toBe("synth");
    expect(libraryAim(synth, null, false)).toEqual({ kind: "synth" });
    const { track } = drumMachine(createDrumMachineFixtureProject());
    expect(libraryAim(track, null, false)).toEqual({ kind: "no-slot" });
    expect(libraryAim(null, null, false)).toEqual({ kind: "no-track" });
  });

  it("aims at a new track when the arrangement asks for a loop, whatever is selected", () => {
    expect(libraryAim(null, null, true)).toEqual({
      kind: "target",
      target: { kind: "new-track" },
    });
  });
});

describe("a Library target", () => {
  it("accepts one-shots in a slot and loops for a loop or a new track", () => {
    const trackId = createSliceFixtureProject().song.tracks[0].id;
    const padId = "pad_x" as PadId;
    expect(targetAssetTypes({ kind: "sampler", trackId })).toEqual(["one-shot"]);
    expect(targetAssetTypes({ kind: "pad", trackId, padId })).toEqual(["one-shot"]);
    expect(targetAssetTypes({ kind: "loop", trackId })).toEqual(["loop"]);
    expect(targetAssetTypes({ kind: "new-track" })).toEqual(["loop"]);
  });

  it("names itself as a path, track then instrument then slot", () => {
    const project = createDrumMachineFixtureProject();
    const { track, pads } = drumMachine(project);
    expect(
      targetPath(project, { kind: "pad", trackId: track.id, padId: pads[0].id }),
    ).toBe(`${track.name} › Drum machine › ${pads[0].name}`);
    const loop = loopTrack(project);
    expect(targetPath(project, { kind: "loop", trackId: loop.id })).toBe(
      `${loop.name} › Loop`,
    );
    const slice = createSliceFixtureProject();
    const sampler = slice.song.tracks[0];
    expect(targetPath(slice, { kind: "sampler", trackId: sampler.id })).toBe(
      `${sampler.name} › Sampler › Sample`,
    );
    expect(targetPath(project, { kind: "new-track" })).toBe("a new track");
  });

  it("reads the sound its slot holds now", () => {
    const project = createDrumMachineFixtureProject();
    const { track, pads } = drumMachine(project);
    const sound = targetSound(project, {
      kind: "pad",
      trackId: track.id,
      padId: pads[1].id,
    });
    expect(sound?.id).toBe(pads[1].assetId);
    const loop = loopTrack(project);
    expect(targetSound(project, { kind: "loop", trackId: loop.id })).not.toBeNull();
    expect(targetSound(project, { kind: "new-track" })).toBeNull();
  });

  it("is the same slot only for the same track, and the same pad", () => {
    const { track, pads } = drumMachine(createDrumMachineFixtureProject());
    const pad = (index: number) =>
      ({ kind: "pad", trackId: track.id, padId: pads[index].id }) as const;
    expect(sameTarget(pad(0), pad(0))).toBe(true);
    expect(sameTarget(pad(0), pad(1))).toBe(false);
    expect(sameTarget(pad(0), { kind: "sampler", trackId: track.id })).toBe(false);
    expect(sameTarget({ kind: "new-track" }, { kind: "new-track" })).toBe(true);
    expect(sameTarget(pad(0), null)).toBe(false);
  });
});
