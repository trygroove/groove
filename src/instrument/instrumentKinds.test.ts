import { describe, expect, it } from "vitest";
import type { RawCommandInput } from "../commands";
import { changeInstrument, executeTransaction, removeNotes } from "../commands";
import type { Project } from "../domain/entities";
import { createFactoryContext } from "../domain/factories";
import {
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { createNewTrack, NEW_TRACK_KINDS } from "../editor/tracks/trackCreation";
import { createManualClock } from "../shared/clock";
import {
  countPadTriggeredHits,
  createInstrumentOfKind,
  INSTRUMENT_KINDS,
  instrumentKindSpec,
  instrumentTypeKey,
  newInstrumentOfKind,
  padTriggeredHits,
} from "./instrumentKinds";

const context = () => createFactoryContext({ ids: createSeededIdFactory(224), now: 0 });

describe("the shared instrument-kind table", () => {
  it("covers every kind the domain has, each with its OPS-02 value", () => {
    expect(INSTRUMENT_KINDS.map((spec) => spec.kind)).toEqual([
      "sampler",
      "drumMachine",
      "synth",
    ]);
    expect(instrumentKindSpec("sampler").analyticsType).toBe("sampler");
    expect(instrumentKindSpec("synth").analyticsType).toBe("synth");
    expect(instrumentKindSpec("drumMachine").analyticsType).toBe("drum_machine");
  });

  it("reads an existing instrument's analytics value from the same table", () => {
    for (const spec of INSTRUMENT_KINDS) {
      const instrument = createInstrumentOfKind(context(), spec.kind);
      expect(instrumentTypeKey(instrument), spec.kind).toBe(spec.analyticsType);
    }
    expect(instrumentTypeKey(null)).toBeUndefined();
  });

  /**
   * The regression this table exists to prevent: creating a track and
   * switching an existing one used to build their instruments from separate
   * copies of these facts, so a created drum machine and a switched-to drum
   * machine opened with different pads.
   */
  it("gives a created track and a switched track the same instrument", () => {
    for (const spec of NEW_TRACK_KINDS) {
      const created = createNewTrack(context(), {
        kind: spec.kind,
        order: 0,
        existingNames: [],
      }).track.instrument;
      const switched = createInstrumentOfKind(context(), spec.kind);
      expect(created, spec.kind).toEqual(switched);
    }
  });
});

describe("createInstrumentOfKind", () => {
  it("builds an empty sampler and a default synth", () => {
    expect(createInstrumentOfKind(context(), "sampler")).toEqual({
      kind: "sampler",
      assetId: null,
      parameters: {},
    });
    expect(createInstrumentOfKind(context(), "synth")).toEqual({
      kind: "synth",
      parameters: {},
    });
  });

  it("builds a drum machine with named, sample-less, uniquely identified pads", () => {
    const instrument = createInstrumentOfKind(context(), "drumMachine");
    if (instrument.kind !== "drumMachine") throw new Error("expected a machine");
    expect(instrument.pads.length).toBeGreaterThan(0);
    expect(instrument.pads.every((pad) => pad.name.length > 0)).toBe(true);
    expect(instrument.pads.every((pad) => pad.assetId === null)).toBe(true);
    expect(new Set(instrument.pads.map((pad) => pad.id)).size).toBe(
      instrument.pads.length,
    );
  });
});

describe("padTriggeredHits", () => {
  it("finds the hits a drum-machine track would strand", () => {
    const project = createDrumMachineFixtureProject();
    const trackId = project.song.tracks[0].id;
    const hits = padTriggeredHits(project, trackId);

    expect(hits.length).toBeGreaterThan(0);
    expect(countPadTriggeredHits(hits)).toBeGreaterThan(0);
    for (const hit of hits) {
      const clip = project.clips.find((candidate) => candidate.id === hit.clipId);
      expect(clip?.trackId).toBe(trackId);
      expect(hit.eventIds.length).toBeGreaterThan(0);
    }
  });

  it("ignores pitched notes, other tracks, and no project at all", () => {
    const pitched = createSliceFixtureProject();
    expect(padTriggeredHits(pitched, pitched.song.tracks[0].id)).toEqual([]);

    const drums = createDrumMachineFixtureProject();
    const otherTrackId = drums.song.tracks[1]?.id;
    if (otherTrackId) {
      expect(padTriggeredHits(drums, otherTrackId)).toEqual([]);
    }

    expect(padTriggeredHits(null, drums.song.tracks[0].id)).toEqual([]);
  });
});

/**
 * The reason the picker clears the hits at all: through the real command
 * kernel, leaving a drum machine with its pad hits in place is rejected whole,
 * so a switch that only replaced the instrument would silently do nothing.
 */
describe("changing a track's instrument through the command kernel", () => {
  const execute = (project: Project, commands: RawCommandInput[]) =>
    executeTransaction(project, commands, {
      actor: "user",
      clock: createManualClock(),
    });

  it("accepts any switch that strands no pad hits", () => {
    const project = createSliceFixtureProject();
    const trackId = project.song.tracks[0].id;
    const result = execute(project, [
      changeInstrument(trackId, createInstrumentOfKind(context(), "drumMachine")),
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects leaving a drum machine until its hits go with it", () => {
    const project = createDrumMachineFixtureProject();
    const trackId = project.song.tracks[0].id;
    const synth = () => createInstrumentOfKind(context(), "synth");

    expect(execute(project, [changeInstrument(trackId, synth())]).ok).toBe(false);

    const hits = padTriggeredHits(project, trackId);
    const cleared = execute(project, [
      ...hits.map((hit) => removeNotes(hit.clipId, hit.eventIds)),
      changeInstrument(trackId, synth()),
    ]);
    expect(cleared.ok).toBe(true);
  });
});

describe("newInstrumentOfKind (#447)", () => {
  it("loads a new drum machine's pads with the starter kit, adding its sounds", () => {
    const project = createSliceFixtureProject();
    const made = newInstrumentOfKind(context(), "drumMachine", project);
    if (made.instrument.kind !== "drumMachine") throw new Error("expected a machine");
    expect(made.instrument.pads.map((pad) => pad.name)).toEqual(["BD", "SD", "HH", "CP"]);
    expect(made.assets).toHaveLength(4);
    expect(made.instrument.pads.map((pad) => pad.assetId)).toEqual(
      made.assets.map((asset) => asset.id),
    );
  });

  it("reuses a kit sound the project already carries", () => {
    const first = newInstrumentOfKind(
      context(),
      "drumMachine",
      createSliceFixtureProject(),
    );
    const project = createSliceFixtureProject();
    const carried = {
      ...project,
      song: { ...project.song, assets: [...project.song.assets, first.assets[0]] },
    };
    const made = newInstrumentOfKind(context(), "drumMachine", carried);
    if (made.instrument.kind !== "drumMachine") throw new Error("expected a machine");
    expect(made.assets).toHaveLength(3);
    expect(made.instrument.pads[0].assetId).toBe(first.assets[0].id);
  });

  it("adds nothing for the other kinds", () => {
    expect(
      newInstrumentOfKind(context(), "synth", createSliceFixtureProject()).assets,
    ).toEqual([]);
  });
});
