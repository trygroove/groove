import { describe, expect, it } from "vitest";
import {
  CONTROL_PARTS,
  controlAddress,
  MASTER_ENTITY,
  SONG_ENTITY,
  sendControl,
} from "../commands/controlAddress";
import { controlsTouchedBy } from "../commands/controls";
import { setParameter } from "../commands/definitions/parameters";
import { createCommandTestProject } from "../commands/testProjects";
import { createDevice } from "../domain/devices";
import type { Project, Track } from "../domain/entities";
import type { DeviceId } from "../domain/ids";
import { SAMPLER_PITCH } from "../domain/parameters";
import { readControl } from "./readControl";

function withTrack(
  project: Project,
  id: string,
  change: (track: Track) => Track,
): Project {
  return {
    ...project,
    song: {
      ...project.song,
      tracks: project.song.tracks.map((track) =>
        track.id === id ? change(track) : track,
      ),
    },
  };
}

describe("readControl (GRV-5)", () => {
  const fx = createCommandTestProject("read-control");

  it("reads the song's tempo and swing as the header shows them", () => {
    const project = {
      ...fx.project,
      song: { ...fx.project.song, tempo: 124, swing: 58 },
    };
    expect(readControl(project, controlAddress(SONG_ENTITY, "tempo"))).toEqual({
      label: "Tempo",
      value: "124 BPM",
    });
    expect(readControl(project, controlAddress(SONG_ENTITY, "swing"))).toEqual({
      label: "Swing",
      value: "58%",
    });
  });

  it("names a track's mixer controls after the track, in their own units", () => {
    const project = withTrack(fx.project, fx.trackAId, (track) => ({
      ...track,
      mixer: { ...track.mixer, volume: -3, pan: -0.25, muted: true },
    }));
    expect(readControl(project, controlAddress(fx.trackAId, "volume"))).toEqual({
      label: "Bass volume",
      value: "-3.0 dB",
    });
    expect(readControl(project, controlAddress(fx.trackAId, "pan"))).toEqual({
      label: "Bass pan",
      value: "L25",
    });
    expect(
      readControl(project, controlAddress(fx.trackAId, CONTROL_PARTS.muted)),
    ).toEqual({ label: "Bass mute", value: "On" });
  });

  it("reads a send by its return's name", () => {
    const reading = readControl(fx.project, sendControl(fx.trackAId, fx.returnId));
    expect(reading?.label).toBe("Bass send to Reverb");
  });

  it("reads the master and a return bus", () => {
    expect(readControl(fx.project, controlAddress(MASTER_ENTITY, "volume"))?.label).toBe(
      "Master volume",
    );
    expect(readControl(fx.project, controlAddress(fx.returnId, "volume"))?.label).toBe(
      "Reverb volume",
    );
  });

  it("reads an instrument parameter with its definition's label and unit", () => {
    const command = setParameter(
      { scope: "instrument", trackId: fx.trackAId, parameterId: "pitch" },
      5,
    );
    const [address] = controlsTouchedBy(command, fx.project);
    if (!address) throw new Error("the command touches nothing");
    const project = withTrack(fx.project, fx.trackAId, (track) =>
      track.instrument?.kind === "sampler"
        ? {
            ...track,
            instrument: {
              ...track.instrument,
              parameters: { ...track.instrument.parameters, pitch: 5 },
            },
          }
        : track,
    );
    expect(readControl(project, address)).toEqual({
      label: `Bass ${SAMPLER_PITCH.label.toLowerCase()}`,
      value: "+5 st",
    });
  });

  it("reads a device parameter as its proposal row always has", () => {
    const device = {
      ...createDevice("dev_comp" as DeviceId, "compressor", 0),
      parameters: { ratio: 4, threshold: -6, attack: 0.02 },
    };
    const project = withTrack(fx.project, fx.trackAId, (track) => ({
      ...track,
      devices: [device],
    }));
    const read = (param: string) =>
      readControl(project, controlAddress(device.id, param))?.value;
    // A ratio is a bare number here, not the knob's "4.0:1" (GRV-179 kept it).
    expect(read("ratio")).toBe("4");
    expect(read("threshold")).toBe("-6.0 dB");
    expect(read("attack")).toBe("20 ms");
  });

  it("reads a drum pad and a clip's notes", () => {
    const [kick] = fx.padIds;
    if (!kick) throw new Error("the fixture has no pads");
    expect(readControl(fx.project, controlAddress(kick, "volume"))?.label).toBe(
      "BD volume",
    );
    const reading = readControl(
      fx.project,
      controlAddress(fx.clipAId, CONTROL_PARTS.notes),
    );
    expect(reading?.label).toBe("Bassline notes");
    expect(reading?.value).toMatch(/^\d+ notes?$/);
  });

  it("is null for an entity the project does not hold", () => {
    expect(readControl(fx.project, controlAddress("trk_gone", "volume"))).toBeNull();
  });

  it("labels a part with no single value, without one", () => {
    expect(
      readControl(fx.project, controlAddress(fx.trackAId, CONTROL_PARTS.header)),
    ).toEqual({ label: "Bass", value: null });
  });
});
