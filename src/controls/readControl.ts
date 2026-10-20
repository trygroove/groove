import {
  CONTROL_PARTS,
  type ControlAddress,
  MASTER_ENTITY,
  SONG_ENTITY,
} from "../commands/controlAddress";
import { deviceTypeDefinition } from "../domain/devices";
import type {
  Clip,
  Device,
  DrumPad,
  Placement,
  Project,
  ReturnBus,
  Track,
} from "../domain/entities";
import { formatDb, formatPan } from "../domain/faders";
import {
  bareParameterId,
  getParameterDefinition,
  MASTER_VOLUME,
  type ParameterDefinition,
  RETURN_VOLUME,
  TRACK_VOLUME,
} from "../domain/parameters";
import { TICKS_PER_BAR } from "../domain/time";
import { formatReadout } from "../domain/valueFormat";

/**
 * A control read back from a project (`UI-004`, GRV-5): what it is called on
 * screen and the value it shows, so a proposal can list "BD volume: 0.0 dB →
 * -3.0 dB" for any address a command touches.
 *
 * `value` is `null` for a part that has no single value to show (a track's
 * header, a device chain): the change is still listed, by its label alone.
 */
export interface ControlReading {
  readonly label: string;
  readonly value: string | null;
}

/**
 * Reads `address` in `project`, or `null` when nothing in it owns the
 * address (an entity a proposal creates is absent before it, one it deletes
 * after it). A pure function of the project: names come from the project and
 * labels and formats from the parameter definitions in `src/domain`, so no
 * label or unit is written down twice.
 */
export function readControl(
  project: Project,
  address: ControlAddress,
): ControlReading | null {
  const { entity, param } = address;
  if (entity === SONG_ENTITY) return readSong(project, param);
  if (entity === MASTER_ENTITY) return readMaster(project, param);

  const { song } = project;
  const track = song.tracks.find((candidate) => candidate.id === entity);
  if (track) return readTrack(project, track, param);
  const bus = song.returns.find((candidate) => candidate.id === entity);
  if (bus) return readReturn(bus, param);
  const device = findDevice(project, entity);
  if (device) return readDevice(device, param);
  const pad = findPad(project, entity);
  if (pad) return readPad(pad, param);
  const clip = project.clips.find((candidate) => candidate.id === entity);
  if (clip) return readClip(clip, param);
  const placement = song.placements.find((candidate) => candidate.id === entity);
  if (placement) return readPlacement(project, placement);
  return null;
}

const onOff = (on: boolean): string => (on ? "On" : "Off");
const percent = (unit: number): string => `${Math.round(unit * 100)}%`;
const plural = (count: number, one: string): string =>
  `${count} ${one}${count === 1 ? "" : "s"}`;
const lower = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

function reading(label: string, value: string | null = null): ControlReading {
  return { label, value };
}

/** A parameter's value in its own unit, as its fader or field reads it. */
function formatParameter(definition: ParameterDefinition, value: number): string {
  switch (definition.unit) {
    case "decibels":
      return formatDb(definition, value);
    case "bipolar":
      return formatPan(value);
    case "percent":
      return `${Math.round(value)}%`;
    case "bpm":
      return `${Number(value.toFixed(2))} BPM`;
    case "bars":
      return plural(value, "bar");
    default:
      // A proposal row has always read a compressor ratio as its bare number,
      // not the knob's "4.0:1". Unifying the readout formatters (GRV-179) was
      // to change no visible string, so it keeps that here.
      if (bareParameterId(definition.id) === "ratio") {
        return String(Number(value.toFixed(2)));
      }
      return formatReadout(definition, value);
  }
}

function readSong(project: Project, param: string): ControlReading | null {
  const { song } = project;
  switch (param) {
    case "tempo":
      return reading("Tempo", `${Number(song.tempo.toFixed(2))} BPM`);
    case "swing":
      return reading("Swing", `${song.swing}%`);
    case CONTROL_PARTS.loop:
      return reading("Loop", onOff(song.loop.enabled));
    case CONTROL_PARTS.key:
      return reading("Key");
    case CONTROL_PARTS.name:
      return reading("Project name");
    case CONTROL_PARTS.tracks:
      return reading("Tracks", plural(song.tracks.length, "track"));
    case CONTROL_PARTS.returns:
      return reading("Returns", plural(song.returns.length, "return"));
    case CONTROL_PARTS.arrangement:
      return reading("Arrangement");
    default:
      return reading("Song");
  }
}

function readMaster(project: Project, param: string): ControlReading {
  const { master } = project.song;
  if (param === "volume") {
    return reading("Master volume", formatDb(MASTER_VOLUME, master.volume));
  }
  if (param === CONTROL_PARTS.devices) {
    return reading("Master devices", plural(master.devices.length, "device"));
  }
  return reading("Master");
}

function readTrack(project: Project, track: Track, param: string): ControlReading {
  const name = track.name;
  if (param.startsWith("sendLevel.")) {
    const returnId = param.slice("sendLevel.".length);
    const bus = project.song.returns.find((candidate) => candidate.id === returnId);
    const send = track.sendConfig.find((candidate) => candidate.returnId === returnId);
    return reading(
      `${name} send to ${bus?.name ?? "a return"}`,
      send ? percent(send.level) : null,
    );
  }
  switch (param) {
    case "volume":
      return reading(`${name} volume`, formatDb(TRACK_VOLUME, track.mixer.volume));
    case "pan":
      return reading(`${name} pan`, formatPan(track.mixer.pan));
    case CONTROL_PARTS.muted:
      return reading(`${name} mute`, onOff(track.mixer.muted));
    case CONTROL_PARTS.soloed:
      return reading(`${name} solo`, onOff(track.mixer.soloed));
    case CONTROL_PARTS.header:
      return reading(name);
    case CONTROL_PARTS.instrument:
      return reading(`${name} instrument`, instrumentName(track));
    case CONTROL_PARTS.sample:
      return reading(`${name} sample`);
    case CONTROL_PARTS.devices:
      return reading(`${name} devices`, plural(track.devices.length, "device"));
    case CONTROL_PARTS.sends:
      return reading(`${name} sends`, plural(track.sendConfig.length, "send"));
    case CONTROL_PARTS.pads:
      return reading(
        `${name} pads`,
        track.instrument?.kind === "drumMachine"
          ? plural(track.instrument.pads.length, "pad")
          : null,
      );
    case CONTROL_PARTS.arrangement:
      return reading(
        `${name} clips`,
        plural(
          project.song.placements.filter((candidate) => candidate.trackId === track.id)
            .length,
          "clip",
        ),
      );
  }
  const instrument = track.instrument;
  const definition = instrument && getParameterDefinition(`${instrument.kind}.${param}`);
  if (instrument && definition) {
    const value = instrument.parameters[param] ?? definition.defaultValue;
    return reading(
      `${name} ${lower(definition.label)}`,
      formatParameter(definition, value),
    );
  }
  return reading(name);
}

function instrumentName(track: Track): string | null {
  switch (track.instrument?.kind) {
    case "sampler":
      return "Sampler";
    case "synth":
      return "Synth";
    case "drumMachine":
      return "Drum machine";
    default:
      return null;
  }
}

function readReturn(bus: ReturnBus, param: string): ControlReading {
  switch (param) {
    case "volume":
      return reading(`${bus.name} volume`, formatDb(RETURN_VOLUME, bus.mixer.volume));
    case "pan":
      return reading(`${bus.name} pan`, formatPan(bus.mixer.pan));
    case CONTROL_PARTS.muted:
      return reading(`${bus.name} mute`, onOff(bus.mixer.muted));
    case CONTROL_PARTS.devices:
      return reading(`${bus.name} devices`, plural(bus.devices.length, "device"));
    default:
      return reading(bus.name);
  }
}

function findDevice(project: Project, id: string): Device | undefined {
  const { song } = project;
  return [
    ...song.tracks.flatMap((track) => track.devices),
    ...song.returns.flatMap((bus) => bus.devices),
    ...song.master.devices,
  ].find((device) => device.id === id);
}

function readDevice(device: Device, param: string): ControlReading {
  const name = deviceTypeDefinition(device.type)?.label ?? "Device";
  if (param === CONTROL_PARTS.bypassed) {
    return reading(`${name} bypass`, onOff(device.bypassed));
  }
  const definition = getParameterDefinition(`${device.type}.${param}`);
  if (definition) {
    const value = device.parameters[param] ?? definition.defaultValue;
    return reading(
      `${name} ${lower(definition.label)}`,
      formatParameter(definition, value),
    );
  }
  return reading(name);
}

function findPad(project: Project, id: string): DrumPad | undefined {
  for (const track of project.song.tracks) {
    if (track.instrument?.kind !== "drumMachine") continue;
    const pad = track.instrument.pads.find((candidate) => candidate.id === id);
    if (pad) return pad;
  }
  return undefined;
}

function readPad(pad: DrumPad, param: string): ControlReading {
  const name = pad.name;
  switch (param) {
    case "volume":
      return reading(`${name} volume`, formatDb(TRACK_VOLUME, pad.mixer.volume));
    case "pan":
      return reading(`${name} pan`, formatPan(pad.mixer.pan));
    case CONTROL_PARTS.muted:
      return reading(`${name} mute`, onOff(pad.mixer.muted));
    case CONTROL_PARTS.soloed:
      return reading(`${name} solo`, onOff(pad.mixer.soloed));
    case CONTROL_PARTS.sample:
      return reading(`${name} sound`);
    case CONTROL_PARTS.choke:
      return reading(
        `${name} choke group`,
        pad.chokeGroup === null ? "None" : String(pad.chokeGroup),
      );
  }
  const definition = getParameterDefinition(`pad.${param}`);
  if (definition) {
    const value = pad.parameters[param] ?? definition.defaultValue;
    return reading(
      `${name} ${lower(definition.label.replace(/^Pad /, ""))}`,
      formatParameter(definition, value),
    );
  }
  return reading(name);
}

function readClip(clip: Clip, param: string): ControlReading {
  switch (param) {
    case CONTROL_PARTS.notes:
      return reading(
        `${clip.name} notes`,
        clip.content.kind === "notes" ? plural(clip.content.events.length, "note") : null,
      );
    case CONTROL_PARTS.length:
      return reading(
        `${clip.name} length`,
        plural(Math.round(clip.lengthTicks / TICKS_PER_BAR), "bar"),
      );
    case CONTROL_PARTS.color:
      return reading(`${clip.name} colour`);
    default:
      return reading(clip.name);
  }
}

function readPlacement(project: Project, placement: Placement): ControlReading {
  const clip = project.clips.find((candidate) => candidate.id === placement.clipId);
  const bar = Math.floor(placement.startTicks / TICKS_PER_BAR) + 1;
  return reading(clip?.name ?? "Clip", `Bar ${bar}`);
}
