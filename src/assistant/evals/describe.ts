/**
 * Descriptive numbers for one applied proposal (GRV-6): note counts, pitch
 * range, velocity, what was added, device and mixer values. Printed in the
 * report so we can see what a sensible threshold would be later; **nothing
 * gates on them**.
 */
import { deviceTypeDefinition } from "../../domain/devices";
import type { Clip, Device, NoteEvent, Project } from "../../domain/entities";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";

export interface ProposalStats {
  readonly commandCount: number;
  /** Notes in the whole project after, minus before. */
  readonly noteDelta: number;
  /** Notes in the clips the proposal added or changed. */
  readonly notesInTouchedClips: number;
  readonly padHitsInTouchedClips: number;
  /** Lowest and highest pitched note in the touched clips. */
  readonly pitchRange: readonly [number, number] | null;
  readonly meanVelocity: number | null;
  /** Touched notes that start off the sixteenth grid. */
  readonly offGridNotes: number;
  readonly tracksAdded: number;
  readonly clipsAdded: number;
  readonly placementsAdded: number;
  readonly devicesAdded: number;
  readonly tempo: number;
  readonly swing: number;
  /** "Compressor ratio=8" for every parameter of an added or changed device. */
  readonly deviceParameters: readonly string[];
  /** "Bass volume=-6 pan=0.2" for every track whose mixer moved. */
  readonly mixer: readonly string[];
}

function events(clip: Clip): readonly NoteEvent[] {
  return clip.content.kind === "notes" ? clip.content.events : [];
}

function noteCount(project: Project): number {
  return project.clips.reduce((sum, clip) => sum + events(clip).length, 0);
}

function devices(project: Project): Device[] {
  return [
    ...project.song.tracks.flatMap((track) => track.devices),
    ...project.song.returns.flatMap((bus) => bus.devices),
    ...project.song.master.devices,
  ];
}

const round = (value: number) => Math.round(value * 100) / 100;

export function describeProposal(
  before: Project,
  after: Project,
  commandCount: number,
): ProposalStats {
  const beforeClips = new Map(
    before.clips.map((clip) => [clip.id, JSON.stringify(clip)]),
  );
  const touched = after.clips.filter(
    (clip) => beforeClips.get(clip.id) !== JSON.stringify(clip),
  );
  const touchedNotes = touched.flatMap(events);
  const pitches = touchedNotes.flatMap((note) =>
    note.trigger.kind === "pitch" ? [note.trigger.pitch] : [],
  );
  // A device that only moved along its chain (one was inserted before it)
  // has not had its settings changed.
  const settings = ({ order: _order, ...rest }: Device) => JSON.stringify(rest);
  const beforeDevices = new Map(
    devices(before).map((device) => [device.id, settings(device)]),
  );
  const touchedDevices = devices(after).filter(
    (device) => beforeDevices.get(device.id) !== settings(device),
  );
  const beforeTracks = new Map(before.song.tracks.map((track) => [track.id, track]));
  const mixer = after.song.tracks.flatMap((track) => {
    const was = beforeTracks.get(track.id)?.mixer;
    if (was && was.volume === track.mixer.volume && was.pan === track.mixer.pan)
      return [];
    return [
      `${track.name} volume=${round(track.mixer.volume)} pan=${round(track.mixer.pan)}`,
    ];
  });
  const count = <T extends { id: string }>(a: readonly T[], b: readonly T[]) => {
    const ids = new Set(a.map((entity) => entity.id));
    return b.filter((entity) => !ids.has(entity.id)).length;
  };
  return {
    commandCount,
    noteDelta: noteCount(after) - noteCount(before),
    notesInTouchedClips: touchedNotes.length,
    padHitsInTouchedClips: touchedNotes.length - pitches.length,
    pitchRange: pitches.length > 0 ? [Math.min(...pitches), Math.max(...pitches)] : null,
    meanVelocity:
      touchedNotes.length > 0
        ? round(
            touchedNotes.reduce((sum, note) => sum + note.velocity, 0) /
              touchedNotes.length,
          )
        : null,
    offGridNotes: touchedNotes.filter(
      (note) => note.startTicks % TICKS_PER_SIXTEENTH !== 0,
    ).length,
    tracksAdded: count(before.song.tracks, after.song.tracks),
    clipsAdded: count(before.clips, after.clips),
    placementsAdded: count(before.song.placements, after.song.placements),
    devicesAdded: count(devices(before), devices(after)),
    tempo: after.song.tempo,
    swing: after.song.swing,
    deviceParameters: touchedDevices.map((device) => {
      const label = deviceTypeDefinition(device.type)?.label ?? device.type;
      const values = Object.entries(device.parameters)
        .map(([key, value]) => `${key}=${round(value)}`)
        .join(" ");
      return `${label}${device.bypassed ? " (bypassed)" : ""}${values ? ` ${values}` : ""}`;
    }),
    mixer,
  };
}
