/**
 * Reading and writing a beat for the "Make a beat" chapter (GRV-43): which
 * drum machine is the lesson's, which of its pads is the kick, the snare or
 * the hats, which steps a pad hits, and the commands that write what is
 * missing. Pure, over a project.
 */
import { addAsset } from "../commands/definitions/assets";
import { addClip } from "../commands/definitions/clips";
import { addPad } from "../commands/definitions/drum";
import { addNotes, removeNotes } from "../commands/definitions/notes";
import type { RawCommandInput } from "../commands/types";
import type { Asset, Clip, DrumPad, NoteEvent, Project, Track } from "../domain/entities";
import {
  createDrumPad,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  type DomainFactoryContext,
} from "../domain/factories";
import type { AssetId, PadId } from "../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import { createFactoryAsset, factoryLibraryEntry } from "../library/factoryLibrary";

/** The drum sounds a lesson asks for, by what a pad's name says it is. */
export type DrumRole = "kick" | "snare" | "hats";

const ROLE_NAMES: Readonly<Record<DrumRole, RegExp>> = {
  kick: /\b(kick|bd|bass ?drum)\b/i,
  snare: /\b(snare|sd|clap|cp|rim)\b/i,
  hats: /\b(hat|hats|hh|hi-?hats?|ch|oh)\b/i,
};

/** The factory sound Show me puts on a new pad of each role. */
const FACTORY_SOUND: Readonly<Record<"clap" | "snare" | "hats", string>> = {
  clap: "starterClap",
  snare: "starterSnare",
  hats: "starterHat",
};

export type DrumTrack = Track & {
  readonly instrument: Extract<NonNullable<Track["instrument"]>, { kind: "drumMachine" }>;
};

export function isDrumTrack(track: Track): track is DrumTrack {
  return track.instrument?.kind === "drumMachine";
}

/** Whether `pad`'s name says it plays `role`. */
export function padPlays(pad: DrumPad, role: DrumRole): boolean {
  return ROLE_NAMES[role].test(pad.name);
}

/**
 * The lesson's drum machine: the first, in track order, with a pad named
 * for a kick, or else the first of any. Null when the song has none.
 */
export function beatTrack(project: Project): DrumTrack | null {
  const drums = [...project.song.tracks]
    .sort((a, b) => a.order - b.order)
    .filter(isDrumTrack);
  return (
    drums.find((track) => track.instrument.pads.some((pad) => padPlays(pad, "kick"))) ??
    drums[0] ??
    null
  );
}

/** The kick pad: the first named for a kick, or else the first pad. */
export function kickPad(track: DrumTrack): DrumPad | null {
  const pads = track.instrument.pads;
  return pads.find((pad) => padPlays(pad, "kick")) ?? pads[0] ?? null;
}

/** The first pad on `track` named for `role`. */
export function padFor(track: DrumTrack, role: DrumRole): DrumPad | null {
  return track.instrument.pads.find((pad) => padPlays(pad, role)) ?? null;
}

/** The note clips on `track`, placed first, then in clip order. */
export function noteClips(project: Project, track: Track): Clip[] {
  const placed = new Set(
    project.song.placements
      .filter((placement) => placement.trackId === track.id)
      .map((placement) => placement.clipId),
  );
  return project.clips
    .filter((clip) => clip.trackId === track.id && clip.content.kind === "notes")
    .sort((a, b) => Number(placed.has(b.id)) - Number(placed.has(a.id)));
}

/**
 * The steps of the bar (0 to 15) `padId` hits in `clip`: a hit counts at
 * the step it starts on, in whichever bar of the clip it falls.
 */
export function stepsHit(clip: Clip, padId: PadId): Set<number> {
  const steps = new Set<number>();
  if (clip.content.kind !== "notes") return steps;
  for (const note of clip.content.events) {
    if (note.trigger.kind !== "pad" || note.trigger.padId !== padId) continue;
    const inBar = note.startTicks % TICKS_PER_BAR;
    if (inBar % TICKS_PER_SIXTEENTH === 0) steps.add(inBar / TICKS_PER_SIXTEENTH);
  }
  return steps;
}

/** Whether one clip of `track` has `padId` on every one of `steps`. */
export function hitsAll(
  project: Project,
  track: DrumTrack,
  padId: PadId,
  steps: readonly number[],
): boolean {
  return noteClips(project, track).some((clip) => {
    const hit = stepsHit(clip, padId);
    return steps.every((step) => hit.has(step));
  });
}

/** `padId`'s notes in `clip`. */
function padNotes(clip: Clip, padId: PadId): NoteEvent[] {
  if (clip.content.kind !== "notes") return [];
  return clip.content.events.filter(
    (note) => note.trigger.kind === "pad" && note.trigger.padId === padId,
  );
}

/** Where `note` falls on the bar's step grid, or null when it is off it. */
function stepOf(note: NoteEvent): number | null {
  const inBar = note.startTicks % TICKS_PER_BAR;
  return inBar % TICKS_PER_SIXTEENTH === 0 ? inBar / TICKS_PER_SIXTEENTH : null;
}

/**
 * Whether one clip of `track` has `padId` on every one of `steps` and on no
 * other step, in any bar of the clip: the pattern and nothing else.
 */
export function hitsExactly(
  project: Project,
  track: DrumTrack,
  padId: PadId,
  steps: readonly number[],
): boolean {
  const wanted = new Set(steps);
  return noteClips(project, track).some((clip) => {
    const notes = padNotes(clip, padId);
    const hit = new Set(notes.map(stepOf));
    return (
      notes.every((note) => {
        const step = stepOf(note);
        return step !== null && wanted.has(step);
      }) && steps.every((step) => hit.has(step))
    );
  });
}

/** Whether `padId` is silent in every clip of `track`. */
export function padSilent(project: Project, track: DrumTrack, padId: PadId): boolean {
  return noteClips(project, track).every((clip) => padNotes(clip, padId).length === 0);
}

/** The commands that take every one of `padId`'s notes out of `track`'s clips. */
export function clearPad(
  project: Project,
  track: DrumTrack,
  padId: PadId,
): RawCommandInput[] {
  return noteClips(project, track).flatMap((clip) => {
    const notes = padNotes(clip, padId);
    return notes.length > 0
      ? [
          removeNotes(
            clip.id,
            notes.map((note) => note.id),
          ),
        ]
      : [];
  });
}

/**
 * The commands that make `padId` play exactly `steps` in the track's first
 * note clip: the hits it is missing are added and every other hit it has
 * there is taken out, in one change. A track with no note clip gets one, as
 * {@link writeHits} does.
 */
export function writePattern(
  project: Project,
  track: DrumTrack,
  padId: PadId,
  steps: readonly number[],
  context: DomainFactoryContext,
): RawCommandInput[] {
  const clip = noteClips(project, track)[0];
  const wanted = new Set(steps);
  const stray = clip
    ? padNotes(clip, padId).filter((note) => {
        const step = stepOf(note);
        return step === null || !wanted.has(step);
      })
    : [];
  const removing =
    clip && stray.length > 0
      ? [
          removeNotes(
            clip.id,
            stray.map((note) => note.id),
          ),
        ]
      : [];
  // The strays are all off the pattern, so what `writeHits` finds missing is
  // the same with or without them.
  return [...removing, ...writeHits(project, track, padId, steps, context)];
}

/**
 * Whether some pad of some drum machine, other than its kick pad and any pad
 * named for `besides` (the hats, for the backbeat: eighths hit 2 and 4 too),
 * hits every one of `steps` in one clip: the backbeat or the hats, whatever
 * the pad is called.
 */
export function anyOtherPadHits(
  project: Project,
  steps: readonly number[],
  besides?: DrumRole,
): boolean {
  return otherPadsHitting(project, steps, besides).length > 0;
}

/** The pads {@link anyOtherPadHits} finds, each with its drum machine. */
export function otherPadsHitting(
  project: Project,
  steps: readonly number[],
  besides?: DrumRole,
): { readonly track: DrumTrack; readonly pad: DrumPad }[] {
  return project.song.tracks.filter(isDrumTrack).flatMap((track) => {
    const kick = kickPad(track);
    return track.instrument.pads
      .filter(
        (pad) =>
          pad.id !== kick?.id &&
          !(besides && padPlays(pad, besides)) &&
          hitsAll(project, track, pad.id, steps),
      )
      .map((pad) => ({ track, pad }));
  });
}

/**
 * The commands that put `padId` on each of `steps` it is missing from, in
 * the track's first note clip; a track with none gets a one-bar clip, placed
 * at bar 1.
 */
export function writeHits(
  project: Project,
  track: DrumTrack,
  padId: PadId,
  steps: readonly number[],
  context: DomainFactoryContext,
): RawCommandInput[] {
  const clip = noteClips(project, track)[0];
  const hit = clip ? stepsHit(clip, padId) : new Set<number>();
  const notes = steps
    .filter((step) => !hit.has(step))
    .map((step) =>
      createNoteEvent(context, {
        startTicks: step * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        padId,
      }),
    );
  if (clip) return notes.length > 0 ? [addNotes(clip.id, notes)] : [];
  const fresh = createNoteClip(context, {
    trackId: track.id,
    name: "Beat",
    lengthTicks: TICKS_PER_BAR,
    color: track.color,
    events: notes,
  });
  const placement = createPlacement(context, {
    clipId: fresh.id,
    trackId: track.id,
    startTicks: 0,
    durationTicks: TICKS_PER_BAR,
  });
  return [addClip(fresh, [placement])];
}

/**
 * The asset for a factory sound: the song's own, when it already has that
 * sound, or a new one with the command that adds it.
 */
export function factorySound(
  project: Project,
  key: string,
  context: DomainFactoryContext,
): { readonly assetId: AssetId; readonly commands: RawCommandInput[] } {
  const { storageRef } = factoryLibraryEntry(key);
  const existing = project.song.assets.find(
    (asset: Asset) => asset.storageRef === storageRef,
  );
  if (existing) return { assetId: existing.id, commands: [] };
  const asset = createFactoryAsset(context, key);
  return { assetId: asset.id, commands: [addAsset(asset)] };
}

/**
 * The commands that give `track` a pad for `role` playing its factory sound,
 * hitting each of `steps`: the pad it has for the role, or a new one named
 * `name`.
 */
export function writePadPart(
  project: Project,
  track: DrumTrack,
  role: "snare" | "hats",
  sound: "clap" | "snare" | "hats",
  name: string,
  steps: readonly number[],
  context: DomainFactoryContext,
): RawCommandInput[] {
  const existing = padFor(track, role);
  if (existing) return writeHits(project, track, existing.id, steps, context);
  const { assetId, commands } = factorySound(project, FACTORY_SOUND[sound], context);
  const pad = createDrumPad(context, { name, assetId });
  return [
    ...commands,
    addPad(track.id, pad),
    ...writeHits(project, track, pad.id, steps, context),
  ];
}
