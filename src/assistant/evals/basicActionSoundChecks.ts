/**
 * The basic production actions' checks (GRV-119) for instruments and sounds,
 * effects, and notes: see `basicActionChecks.ts` for how a case is judged.
 */
import type { Asset, Device, NoteEvent, Project, Track } from "../../domain/entities";
import {
  type ParameterDefinition,
  readInstrumentParameter,
} from "../../domain/parameters";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { type FactoryLibraryEntry, factoryLibrary } from "../../library/factoryLibrary";
import {
  added,
  anyOf,
  type BasicAction,
  clipPath,
  fail,
  fixtureClip,
  fixtureTrack,
  notesOf,
  pass,
  placementsOn,
  same,
  soundKeys,
  trackNamed,
  trackPath,
  under,
} from "./basicActionPaths";
import type { CheckResult } from "./checks";

// ---------------------------------------------------------------------------
// Instruments and sounds
// ---------------------------------------------------------------------------

function padsOf(track: Track | undefined) {
  return track?.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
}

/** The library entry an asset resolved from, matched on pack and storage path. */
export function libraryEntryOf(
  asset: Asset | undefined,
  library: readonly FactoryLibraryEntry[] = factoryLibrary(),
): FactoryLibraryEntry | undefined {
  if (!asset) return undefined;
  return library.find(
    (entry) => entry.storageRef === asset.storageRef && entry.pack.id === asset.packId,
  );
}

function assetOf(project: Project, id: string | null) {
  return project.song.assets.find((asset) => asset.id === id);
}

/**
 * The pad points at a different asset whose library `role` is `role` and
 * whose sample is longer than the one it had; every other pad is as it was.
 * A longer decay on the same sample does not pass.
 */
export function checkLongerSample(
  before: Project,
  after: Project,
  trackName: string,
  padName: string,
  role: string,
  library: readonly FactoryLibraryEntry[] = factoryLibrary(),
): CheckResult {
  const pads = padsOf(fixtureTrack(before, trackName));
  const pad = pads.find((entry) => entry.name === padName);
  if (!pad) throw new Error(`The fixture has no pad named "${padName}"`);
  const nowPads = padsOf(trackNamed(after, trackName));
  const now = nowPads.find((entry) => entry.id === pad.id);
  if (!now) return fail(`Removes the "${padName}" pad`);
  const others = (list: typeof pads) => list.filter((entry) => entry.id !== pad.id);
  if (!same(others(pads), others(nowPads))) return fail("Changes other pads");
  if (now.assetId === pad.assetId) return fail(`"${padName}" plays the same sample`);
  const was = assetOf(before, pad.assetId);
  const asset = assetOf(after, now.assetId);
  const entry = libraryEntryOf(asset, library);
  if (entry?.role !== role) {
    return fail(`The new sample's role is ${entry?.role ?? "unknown"}, not ${role}`);
  }
  const length = asset?.durationSeconds ?? 0;
  const old = was?.durationSeconds ?? Number.POSITIVE_INFINITY;
  return length > old
    ? pass(`"${padName}" plays "${asset?.name}", ${length} s against ${old} s`)
    : fail(`The new ${role} is ${length} s, not longer than ${old} s`);
}

export function swapsToLongerSample(
  trackName: string,
  padName: string,
  role: string,
): BasicAction {
  return {
    target: (before, after) => checkLongerSample(before, after, trackName, padName, role),
    allows: (before) => {
      const pad = padsOf(fixtureTrack(before, trackName)).find(
        (entry) => entry.name === padName,
      );
      return anyOf(
        under(`${trackPath(before, trackName)}.instrument.pads.${pad?.id}.assetId`),
        under("song.assets"),
      );
    },
  };
}

/** A new pad on the drum machine plays a sample whose library role is `role`. */
export function addsPadWithRole(trackName: string, role: string): BasicAction {
  return {
    target: (before, after) => {
      const was = padsOf(fixtureTrack(before, trackName));
      const now = padsOf(trackNamed(after, trackName));
      const kept = now.filter((pad) => was.some((entry) => entry.id === pad.id));
      if (!same(kept, was)) return fail("Changes or removes the pads it had");
      const fresh = now.filter((pad) => !was.some((entry) => entry.id === pad.id));
      const match = fresh.find(
        (pad) => libraryEntryOf(assetOf(after, pad.assetId))?.role === role,
      );
      return match
        ? pass(`Adds the pad "${match.name}", a ${role}`)
        : fail(`Adds ${fresh.length} pads, none playing a ${role}`);
    },
    allows: (before) =>
      anyOf(
        under(`${trackPath(before, trackName)}.instrument.pads`),
        under("song.assets"),
      ),
  };
}

/** The track plays a `kind` instrument now, and keeps its clips and placements. */
export function swapsInstrument(
  trackName: string,
  kind: "sampler" | "synth",
): BasicAction {
  return {
    target: (before, after) => {
      const track = fixtureTrack(before, trackName);
      const now = after.song.tracks.find((entry) => entry.id === track.id);
      if (now?.instrument?.kind !== kind) {
        return fail(
          `"${trackName}" plays ${now?.instrument?.kind ?? "nothing"}, not a ${kind}`,
        );
      }
      const own = (project: Project) => [
        project.clips.filter((clip) => clip.trackId === track.id),
        placementsOn(project, track.id),
      ];
      return same(own(before), own(after))
        ? pass(`"${trackName}" is a ${kind}, its clips kept`)
        : fail(`"${trackName}" lost or changed clips`);
    },
    allows: (before) => under(`${trackPath(before, trackName)}.instrument`),
  };
}

/** One of the track's instrument parameters went down. */
export function lowersParameter(
  trackName: string,
  definition: ParameterDefinition,
): BasicAction {
  const read = (track: Track | undefined) =>
    track?.instrument
      ? readInstrumentParameter(definition, track.instrument.parameters)
      : null;
  return {
    target: (before, after) => {
      const was = read(fixtureTrack(before, trackName));
      const now = read(trackNamed(after, trackName));
      if (
        trackNamed(after, trackName)?.instrument?.kind !==
        fixtureTrack(before, trackName).instrument?.kind
      ) {
        return fail(`Replaces the "${trackName}" instrument`);
      }
      return now !== null && was !== null && now < was
        ? pass(`${definition.label} ${was} → ${now}`)
        : fail(`${definition.label} ${was} → ${now}: not lower`);
    },
    allows: (before) => {
      const key = definition.id.slice(definition.id.indexOf(".") + 1);
      return under(`${trackPath(before, trackName)}.instrument.parameters.${key}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function devicesOf(project: Project, trackName: string): readonly Device[] {
  return trackNamed(project, trackName)?.devices ?? [];
}

/** Devices as they sound, without where they sit in the chain. */
const unordered = (devices: readonly Device[]) =>
  [...devices]
    .map(({ order: _order, ...rest }) => rest)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** A new `type` device on the track; the ones it had are as they were. */
export function addsDevice(trackName: string, type: string): BasicAction {
  return {
    target: (before, after) => {
      const was = devicesOf(before, trackName);
      const now = devicesOf(after, trackName);
      const kept = now.filter((device) => was.some((entry) => entry.id === device.id));
      if (!same(unordered(kept), unordered(was)))
        return fail("Changes the devices it had");
      const fresh = now.filter((device) => !was.some((entry) => entry.id === device.id));
      return fresh.some((device) => device.type === type)
        ? pass(`"${trackName}" has a new ${type}`)
        : fail(`No new ${type} on "${trackName}"`);
    },
    allows: (before) => under(`${trackPath(before, trackName)}.devices`),
  };
}

function onlyDevice(project: Project, trackName: string, type: string): Device {
  const devices = devicesOf(project, trackName).filter((device) => device.type === type);
  if (devices.length !== 1)
    throw new Error(`The fixture has no single ${type} on "${trackName}"`);
  return devices[0];
}

/** The track's `type` device is gone; the rest are as they were. */
export function removesDevice(trackName: string, type: string): BasicAction {
  return {
    target: (before, after) => {
      const device = onlyDevice(before, trackName, type);
      const now = devicesOf(after, trackName);
      if (now.some((entry) => entry.id === device.id))
        return fail(`The ${type} is still there`);
      const rest = devicesOf(before, trackName).filter((entry) => entry.id !== device.id);
      return same(unordered(now), unordered(rest))
        ? pass(`The ${type} is off "${trackName}"`)
        : fail("Changes the other devices");
    },
    allows: (before) => under(`${trackPath(before, trackName)}.devices`),
  };
}

/** The same `type` device's `parameter` went up. */
export function raisesDeviceParameter(
  trackName: string,
  type: string,
  parameter: string,
): BasicAction {
  return {
    target: (before, after) => {
      const device = onlyDevice(before, trackName, type);
      const now = devicesOf(after, trackName).find((entry) => entry.id === device.id);
      const was = device.parameters[parameter];
      const is = now?.parameters[parameter];
      if (!now) return fail(`Removes or replaces the ${type}`);
      return is !== undefined && is > was
        ? pass(`${type} ${parameter} ${was} → ${is}`)
        : fail(`${type} ${parameter} ${was} → ${is}: not higher`);
    },
    allows: (before) =>
      under(
        `${trackPath(before, trackName)}.devices.${onlyDevice(before, trackName, type).id}.parameters.${parameter}`,
      ),
  };
}

/** The same devices, none recreated or changed, with `first` ahead of `second`. */
export function putsBefore(
  trackName: string,
  first: string,
  second: string,
): BasicAction {
  return {
    target: (before, after) => {
      const was = devicesOf(before, trackName);
      const now = devicesOf(after, trackName);
      if (!same(unordered(now), unordered(was))) {
        return fail("Recreates, removes or changes a device");
      }
      const a = onlyDevice(after, trackName, first);
      const b = onlyDevice(after, trackName, second);
      return a.order < b.order
        ? pass(`The ${first} runs before the ${second}`)
        : fail(`The ${first} still runs after the ${second}`);
    },
    allows: (before) => {
      const path = trackPath(before, trackName);
      return (candidate) =>
        candidate.startsWith(`${path}.devices.`) && candidate.endsWith(".order");
    },
  };
}

/** One new return with a `type` device on it, and a send to it from each track. */
export function setsUpSend(trackNames: readonly string[], type: string): BasicAction {
  return {
    target: (before, after) => {
      const existing = new Set<string>(before.song.returns.map((bus) => bus.id));
      const fresh = after.song.returns.filter((bus) => !existing.has(bus.id));
      if (fresh.length !== 1) return fail(`Adds ${fresh.length} returns, not one`);
      const [bus] = fresh;
      if (!bus.devices.some((device) => device.type === type)) {
        return fail(`The new return has no ${type}`);
      }
      const missing = trackNames.filter(
        (name) =>
          !trackNamed(after, name)?.sendConfig.some((send) => send.returnId === bus.id),
      );
      return missing.length === 0
        ? pass(`"${bus.name}" has a ${type}, fed by ${trackNames.join(" and ")}`)
        : fail(`No send to "${bus.name}" from ${missing.join(", ")}`);
    },
    allows: (before) =>
      anyOf(
        added(
          "song.returns",
          before.song.returns.map((bus) => bus.id),
        ),
        under(...trackNames.map((name) => `${trackPath(before, name)}.sendConfig`)),
      ),
  };
}

// ---------------------------------------------------------------------------
// Notes and MIDI
// ---------------------------------------------------------------------------

/** What a note edit is judged on: the clip's notes before and after. */
function noteEdit(
  clipName: string,
  judge: (was: readonly NoteEvent[], now: readonly NoteEvent[]) => CheckResult,
): BasicAction {
  return {
    target: (before, after) => {
      const clip = fixtureClip(before, clipName);
      const now = after.clips.find((entry) => entry.id === clip.id);
      if (!now) return fail(`Removes the clip "${clipName}"`);
      return judge(notesOf(clip), notesOf(now));
    },
    allows: (before) => under(`${clipPath(before, clipName)}.content.events`),
  };
}

const onGrid = (event: NoteEvent) => event.startTicks % TICKS_PER_SIXTEENTH === 0;

/** As many notes, the same pads and pitches and velocities, every start on the 16th grid. */
export function quantizes(clipName: string): BasicAction {
  return noteEdit(clipName, (was, now) => {
    const sounds = (events: readonly NoteEvent[]) =>
      soundKeys(events, (event) => [event.trigger, event.velocity]);
    if (sounds(was) !== sounds(now)) return fail("Adds, removes or changes notes");
    const off = now.filter((event) => !onGrid(event)).length;
    return off === 0
      ? pass(`All ${now.length} notes start on a 16th`)
      : fail(`${off} of ${now.length} notes start off the 16th grid`);
  });
}

/** Every note `semitones` higher, its timing and velocity as they were. */
export function transposes(clipName: string, semitones: number): BasicAction {
  return noteEdit(clipName, (was, now) => {
    const raised = was.map((event) =>
      event.trigger.kind === "pitch"
        ? {
            ...event,
            trigger: { kind: "pitch" as const, pitch: event.trigger.pitch + semitones },
          }
        : event,
    );
    return soundKeys(raised) === soundKeys(now)
      ? pass(`All ${now.length} notes moved ${semitones} semitones`)
      : fail(`The notes are not the clip moved ${semitones} semitones`);
  });
}

/** As many notes on the same pads, now varying in velocity or off the strict grid. */
export function humanizes(clipName: string): BasicAction {
  return noteEdit(clipName, (was, now) => {
    const triggers = (events: readonly NoteEvent[]) =>
      soundKeys(events, (event) => [event.trigger]);
    if (triggers(was) !== triggers(now)) return fail("Adds or removes notes");
    if (soundKeys(was) === soundKeys(now)) return fail("The notes are as they were");
    const velocities = new Set(now.map((event) => event.velocity)).size;
    const loose = now.filter((event) => !onGrid(event)).length;
    return velocities > 1 || loose > 0
      ? pass(`${velocities} different velocities, ${loose} notes off the grid`)
      : fail("Every note is still on the grid at one velocity");
  });
}

/**
 * Every note starts at half its tick and lasts half as long. Repeating the
 * halved figure to fill the second half of the clip also passes.
 */
export function doublesSpeed(clipName: string): BasicAction {
  return {
    target: (before, after) => {
      const clip = fixtureClip(before, clipName);
      const kept = after.clips.find((entry) => entry.id === clip.id);
      if (!kept) return fail(`Removes the clip "${clipName}"`);
      const now = notesOf(kept);
      const halved = notesOf(clip).map((event) => ({
        ...event,
        startTicks: Math.round(event.startTicks / 2),
        durationTicks: Math.max(1, Math.round(event.durationTicks / 2)),
      }));
      const repeated = [
        ...halved,
        ...halved.map((event) => ({
          ...event,
          startTicks: event.startTicks + clip.lengthTicks / 2,
        })),
      ];
      const got = soundKeys(now);
      if (got === soundKeys(halved)) return pass(`All ${now.length} notes twice as fast`);
      if (got === soundKeys(repeated))
        return pass("Twice as fast, repeated to fill the clip");
      return fail("The notes do not start and end at half their ticks");
    },
    allows: (before) => under(clipPath(before, clipName)),
  };
}

/** The clip is still there, with no notes. */
export function clearsClip(clipName: string): BasicAction {
  return noteEdit(clipName, (_was, now) =>
    now.length === 0
      ? pass(`"${clipName}" is empty and still there`)
      : fail(`${now.length} notes left`),
  );
}
