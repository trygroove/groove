/**
 * The parts of a track, as "Finish a track" (GRV-44) reads them: the beat's
 * drum machines, and the bass, the chords and the hook, each the first
 * instrument track named for it; the song's key; and where on the
 * arrangement each part plays. Pure, over a project.
 *
 * A part is found by its track's name, as a drum pad's role is by its pad's
 * (`drums.ts`): a lesson asks the producer to name the track, and Show me
 * names the ones it adds.
 */

import {
  addPlacement,
  overwritePlacements,
  removePlacement,
} from "../commands/definitions/placements";
import { addTrack } from "../commands/definitions/tracks";
import type { RawCommandInput } from "../commands/types";
import type { NoteEvent, Placement, Project, Track } from "../domain/entities";
import {
  createNoteClip,
  createPlacement,
  createSynthInstrument,
  createTrack,
  type DomainFactoryContext,
} from "../domain/factories";
import type { PlacementId, TrackId } from "../domain/ids";
import { isChromatic, type MusicalKey, SCALE_INTERVALS } from "../domain/musicalKey";
import { TICKS_PER_BAR } from "../domain/time";
import { isDrumTrack, noteClips } from "./drums";
import type { BeatStyle } from "./ids";
import type { LessonSettings } from "./types";

/** The melodic parts a track lesson adds, by what a track's name says it is. */
export type PartRole = "bass" | "chords" | "hook";

const PART_NAMES: Readonly<Record<PartRole, RegExp>> = {
  bass: /\b(bass|sub|808)\b/i,
  chords: /\b(chords?|keys|pads?|piano|stabs?)\b/i,
  hook: /\b(hook|lead|melody|pluck|riff|topline)\b/i,
};

/** What Show me calls the track it adds for each part. */
export const PART_TRACK_NAMES: Readonly<Record<PartRole, string>> = {
  bass: "Bass",
  chords: "Chords",
  hook: "Hook",
};

/** Whether `track` is an instrument track whose name says it plays `role`. */
export function playsPart(track: Track, role: PartRole): boolean {
  const kind = track.instrument?.kind;
  return (kind === "synth" || kind === "sampler") && PART_NAMES[role].test(track.name);
}

/** The track for `role`: the first, in track order, named for it. */
export function partTrack(project: Project, role: PartRole): Track | null {
  return (
    [...project.song.tracks]
      .sort((a, b) => a.order - b.order)
      .find((track) => playsPart(track, role)) ?? null
  );
}

/** The key a lesson's notes are written in, when the song has none yet. */
export const STYLE_KEYS: Readonly<Record<BeatStyle, MusicalKey>> = {
  four_on_the_floor: { root: 9, scale: "minor" },
  boom_bap: { root: 0, scale: "minor" },
  trap: { root: 5, scale: "minor" },
};

/** Pitch-class names as the piano roll spells them, C = 0. */
const PITCH_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
] as const;

/** "A minor": a key's name, as the Key panel shows it. */
export function keyWords(key: MusicalKey): string {
  return `${PITCH_NAMES[key.root]} ${key.scale.replace("_", " ")}`;
}

/** The song's key, or the style's while the song has none. */
export function lessonKey(project: Project, settings: LessonSettings): MusicalKey {
  return isChromatic(project.song.key) ? STYLE_KEYS[settings.style] : project.song.key;
}

/**
 * The MIDI pitch of scale degree `degree` (0 is the root) of `key`, counted
 * up from the C at `c`: degree 7 of a seven-note scale is the root an octave
 * up.
 */
export function degreePitch(key: MusicalKey, degree: number, c: number): number {
  const steps = SCALE_INTERVALS[key.scale];
  const octave = Math.floor(degree / steps.length);
  const index = degree - octave * steps.length;
  return c + key.root + steps[index] + 12 * octave;
}

/** Every note of `track`'s note clips. */
export function partNotes(project: Project, track: Track): NoteEvent[] {
  return noteClips(project, track).flatMap((clip) =>
    clip.content.kind === "notes" ? clip.content.events : [],
  );
}

/**
 * The commands that add a synth track for `role`, named for it, with one
 * clip of `bars` bars holding `events`, placed looped from bar 1 for
 * `loopBars`.
 */
export function addPartTrack(
  project: Project,
  role: PartRole,
  events: readonly NoteEvent[],
  context: DomainFactoryContext,
  bars = 1,
  loopBars = 4,
): RawCommandInput[] {
  const track = createTrack(context, {
    name: PART_TRACK_NAMES[role],
    order: project.song.tracks.length,
    instrument: createSynthInstrument(),
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: PART_TRACK_NAMES[role],
    lengthTicks: bars * TICKS_PER_BAR,
    color: track.color,
    events: [...events],
  });
  const placement = createPlacement(context, {
    clipId: clip.id,
    trackId: track.id,
    startTicks: 0,
    durationTicks: Math.max(bars, loopBars) * TICKS_PER_BAR,
    looped: loopBars > bars,
  });
  return [addTrack(track, { clips: [clip], placements: [placement] })];
}

// --- The arrangement, a bar at a time -------------------------------------

/** A run of bars, from bar `from` up to, not including, `to`; bar 1 is 0. */
export interface BarSpan {
  readonly from: number;
  readonly to: number;
}

const ticksOf = (span: BarSpan) => ({
  start: span.from * TICKS_PER_BAR,
  end: span.to * TICKS_PER_BAR,
});

function placementsOf(project: Project, trackId: TrackId): Placement[] {
  return project.song.placements
    .filter((placement) => placement.trackId === trackId)
    .sort((a, b) => a.startTicks - b.startTicks);
}

/** Whether any of `trackId`'s clips plays somewhere in `span`. */
export function playsIn(project: Project, trackId: TrackId, span: BarSpan): boolean {
  const { start, end } = ticksOf(span);
  return placementsOf(project, trackId).some(
    (placement) =>
      placement.startTicks < end &&
      placement.startTicks + placement.durationTicks > start,
  );
}

/** Whether `trackId`'s clips play through every tick of `span`. */
export function fills(project: Project, trackId: TrackId, span: BarSpan): boolean {
  const { start, end } = ticksOf(span);
  let reach = start;
  for (const placement of placementsOf(project, trackId)) {
    if (placement.startTicks > reach) break;
    reach = Math.max(reach, placement.startTicks + placement.durationTicks);
    if (reach >= end) return true;
  }
  return reach >= end;
}

/** Where the song ends: the end of its last clip, in ticks. */
export function songEnd(project: Project): number {
  return project.song.placements.reduce(
    (end, placement) => Math.max(end, placement.startTicks + placement.durationTicks),
    0,
  );
}

/**
 * The tracks a song's arrangement is made of: every instrument track with a
 * clip on the arrangement, in track order.
 */
export function arrangedTracks(project: Project): Track[] {
  const placed = new Set(project.song.placements.map((placement) => placement.trackId));
  return [...project.song.tracks]
    .sort((a, b) => a.order - b.order)
    .filter((track) => track.instrument !== null && placed.has(track.id));
}

/** The song's drum machines that have clips on the arrangement. */
export function arrangedDrums(project: Project): Track[] {
  return arrangedTracks(project).filter(isDrumTrack);
}

/** The arranged tracks for `roles`. */
export function arrangedParts(project: Project, roles: readonly PartRole[]): Track[] {
  return arrangedTracks(project).filter((track) =>
    roles.some((role) => playsPart(track, role)),
  );
}

/**
 * The commands that take everything `trackIds` play in `span` off the
 * arrangement: a clip inside it removed, one across its edge trimmed, one
 * across all of it split around it, as the arrangement's own overwrite does.
 */
export function clearSpan(
  project: Project,
  trackIds: readonly TrackId[],
  span: BarSpan,
  context: DomainFactoryContext,
): RawCommandInput[] {
  const { start, end } = ticksOf(span);
  return trackIds.flatMap((trackId) =>
    overwritePlacements(
      project,
      { trackId, startTicks: start, durationTicks: end - start, clipOffsetTicks: 0 },
      () => context.ids("placement") as PlacementId,
    ),
  );
}

/**
 * The commands that make `track` play its first clip, looped, through all of
 * `span`, in place of whatever it played there.
 */
export function fillSpan(
  project: Project,
  track: Track,
  span: BarSpan,
  context: DomainFactoryContext,
): RawCommandInput[] {
  const first = placementsOf(project, track.id)[0];
  const clipId = first?.clipId ?? noteClips(project, track)[0]?.id;
  if (!clipId) return [];
  const { start, end } = ticksOf(span);
  const inside = placementsOf(project, track.id).filter(
    (placement) =>
      placement.startTicks >= start &&
      placement.startTicks + placement.durationTicks <= end,
  );
  const placement = createPlacement(context, {
    clipId,
    trackId: track.id,
    startTicks: start,
    durationTicks: end - start,
    looped: true,
  });
  return [
    ...inside.map((each) => removePlacement(each.id)),
    ...overwritePlacements(
      {
        ...project,
        song: {
          ...project.song,
          placements: project.song.placements.filter((each) => !inside.includes(each)),
        },
      },
      placement,
      () => context.ids("placement") as PlacementId,
    ),
    addPlacement(placement),
  ];
}
