/**
 * The projects the basic production actions set (GRV-119) runs against.
 *
 * Built like the musical evals' fixtures (`fixtures.ts`): from the domain
 * factories and the factory library, seeded, so every run sends the same
 * project with the same IDs, and every sound is a bundled factory asset.
 * Each is small, with plainly named tracks and clips, so a request such as
 * "Mute the hats" has one right answer.
 *
 * - {@link createBasicLoopProject}: a one-bar drum loop placed once.
 * - {@link createBasicArrangementProject}: drums, bass, a lead with a verse
 *   and a chorus, and vocals, laid out over 16 bars at 120 BPM.
 * - {@link createBasicMixProject}: seven tracks (Kick, Snare, Hats, Bass,
 *   Guitar, Pad, Vocals), each with a one-bar clip placed for 8 bars;
 *   optionally with the Hats muted or a Reverb on the Snare, the states the
 *   "undo" and "take it off again" cases follow.
 * - {@link createBasicKitProject}: one drum machine (Kick, Snare, Hat) on the
 *   factory kit, with the factory clap and a longer factory kick in the
 *   project but on no pad.
 * - {@link createBasicSynthProject}: a synth with a riff beside a drum track.
 * - {@link createBasicEffectsProject}: Vocals with a Reverb then a Delay.
 * - {@link createBasicNotesProject}: hats (on the grid or loose), a melody, a
 *   bassline and chords, each one clip.
 */
import { createDevice, type DeviceTypeId } from "../../domain/devices";
import type { Clip, Device, Project, Song, Track } from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createEmptySong,
  createNewProjectMaster,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createSamplerInstrument,
  createSynthInstrument,
  createTrack,
  type DomainFactoryContext,
} from "../../domain/factories";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import { createFactoryAsset } from "../../library/factoryLibrary";
import { evalContext, evalProject, hits, notes } from "./fixtures";

const EIGHTH = 2 * TICKS_PER_SIXTEENTH;
const QUARTER = 4 * TICKS_PER_SIXTEENTH;

/** A part: its track, the clips on it, and where they are placed. */
interface Part {
  readonly track: Track;
  readonly clips: readonly Clip[];
  readonly placements: Song["placements"];
}

type Context = DomainFactoryContext;

/** One clip on its track, placed from `startBar` for `bars`, looped. */
function placed(
  context: Context,
  clip: Clip,
  startBar: number,
  bars: number,
  looped = true,
): Song["placements"][number] {
  return createPlacement(context, {
    clipId: clip.id,
    trackId: clip.trackId,
    startTicks: startBar * TICKS_PER_BAR,
    durationTicks: bars * TICKS_PER_BAR,
    looped,
  });
}

/** The factory kit's four sounds, created once per project. */
function kitAssets(context: Context) {
  return {
    kick: createFactoryAsset(context, "starterKick"),
    clap: createFactoryAsset(context, "starterClap"),
    snare: createFactoryAsset(context, "starterSnare"),
    hat: createFactoryAsset(context, "starterHat"),
  };
}
type KitAssets = ReturnType<typeof kitAssets>;

/** A drum machine with Kick, Snare and Hat pads, and one bar of a plain beat. */
function drumsPart(
  context: Context,
  assets: KitAssets,
  order: number,
  clipName: string,
): { track: Track; clip: Clip } {
  const kick = createDrumPad(context, { name: "Kick", assetId: assets.kick.id });
  const snare = createDrumPad(context, { name: "Snare", assetId: assets.snare.id });
  const hat = createDrumPad(context, { name: "Hat", assetId: assets.hat.id });
  const track = createTrack(context, {
    name: "Drums",
    order,
    instrument: createDrumMachineInstrument([kick, snare, hat]),
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: clipName,
    lengthTicks: TICKS_PER_BAR,
    events: [
      ...hits(context, kick.id, [0, 8], 0.9),
      ...hits(context, snare.id, [4, 12], 0.8),
      ...hits(context, hat.id, [2, 6, 10, 14], 0.6),
    ],
  });
  return { track, clip };
}

/** A one-pad drum machine track playing `steps` of a bar. */
function onePadTrack(
  context: Context,
  name: string,
  order: number,
  assetId: KitAssets["kick"]["id"],
  clipName: string,
  steps: readonly number[],
  volume?: number,
): { track: Track; clip: Clip } {
  const pad = createDrumPad(context, { name: name === "Hats" ? "Hat" : name, assetId });
  const track = createTrack(context, {
    name,
    order,
    volume,
    instrument: createDrumMachineInstrument([pad]),
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: clipName,
    lengthTicks: TICKS_PER_BAR,
    events: hits(context, pad.id, steps, 0.8),
  });
  return { track, clip };
}

/** A pitched track (a synth unless said) with one clip of `events`. */
function pitchedTrack(
  context: Context,
  name: string,
  order: number,
  clipName: string,
  events: readonly (readonly [pitch: number, start: number, duration: number])[],
  options: { sampler?: boolean; lengthBars?: number; devices?: Device[] } = {},
): { track: Track; clip: Clip } {
  const track = createTrack(context, {
    name,
    order,
    instrument: options.sampler ? createSamplerInstrument() : createSynthInstrument(),
    devices: options.devices,
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: clipName,
    lengthTicks: (options.lengthBars ?? 1) * TICKS_PER_BAR,
    events: notes(context, events),
  });
  return { track, clip };
}

function songOf(
  context: Context,
  tempo: number,
  parts: readonly Part[],
  assets: Song["assets"],
): Song {
  return {
    ...createEmptySong(tempo),
    master: createNewProjectMaster(context),
    tracks: parts.map((part) => part.track),
    placements: parts.flatMap((part) => part.placements),
    assets,
  };
}

function build(
  context: Context,
  name: string,
  tempo: number,
  parts: readonly Part[],
  assets: Song["assets"],
): Project {
  return evalProject(
    context,
    name,
    songOf(context, tempo, parts, assets),
    parts.flatMap((part) => part.clips),
  );
}

const VOCAL_LINE: readonly (readonly [number, number, number])[] = [
  [64, 0, QUARTER],
  [67, QUARTER, QUARTER],
  [69, 2 * QUARTER, 2 * QUARTER],
];

const BASSLINE: readonly (readonly [number, number, number])[] = [
  [33, 0, EIGHTH],
  [33, 2 * EIGHTH, EIGHTH],
  [36, 4 * EIGHTH, EIGHTH],
  [31, 6 * EIGHTH, EIGHTH],
];

/** A one-bar drum loop, "Loop", placed once and not looped. */
export function createBasicLoopProject(): Project {
  const context = evalContext("eval-basic-loop");
  const assets = kitAssets(context);
  const drums = drumsPart(context, assets, 0, "Loop");
  return build(
    context,
    "One bar",
    120,
    [
      {
        ...drums,
        clips: [drums.clip],
        placements: [placed(context, drums.clip, 0, 1, false)],
      },
    ],
    [assets.kick, assets.snare, assets.hat],
  );
}

/**
 * 16 bars at 120 BPM: Drums for all 16, Bass for the first 4, a Lead with a
 * "Verse" for bars 1 to 8 and a "Chorus" for bars 9 to 16, and Vocals.
 */
export function createBasicArrangementProject(): Project {
  const context = evalContext("eval-basic-arrangement");
  const assets = kitAssets(context);
  const drums = drumsPart(context, assets, 0, "Beat");
  const bass = pitchedTrack(context, "Bass", 1, "Bassline", BASSLINE);
  const lead = createTrack(context, {
    name: "Lead",
    order: 2,
    instrument: createSynthInstrument(),
  });
  const verse = createNoteClip(context, {
    trackId: lead.id,
    name: "Verse",
    lengthTicks: 2 * TICKS_PER_BAR,
    events: notes(context, [
      [69, 0, QUARTER],
      [72, 2 * QUARTER, QUARTER],
      [71, 4 * QUARTER, 2 * QUARTER],
    ]),
  });
  const chorus = createNoteClip(context, {
    trackId: lead.id,
    name: "Chorus",
    lengthTicks: 2 * TICKS_PER_BAR,
    events: notes(context, [
      [76, 0, QUARTER],
      [74, QUARTER, QUARTER],
      [72, 2 * QUARTER, 2 * QUARTER],
      [69, 4 * QUARTER, 4 * QUARTER],
    ]),
  });
  const vocals = pitchedTrack(context, "Vocals", 3, "Vocal line", VOCAL_LINE, {
    sampler: true,
  });
  const parts: Part[] = [
    { ...drums, clips: [drums.clip], placements: [placed(context, drums.clip, 0, 16)] },
    { ...bass, clips: [bass.clip], placements: [placed(context, bass.clip, 0, 4)] },
    {
      track: lead,
      clips: [verse, chorus],
      placements: [placed(context, verse, 0, 8), placed(context, chorus, 8, 8)],
    },
    {
      ...vocals,
      clips: [vocals.clip],
      placements: [placed(context, vocals.clip, 0, 16)],
    },
  ];
  return build(context, "Verse and chorus", 120, parts, [
    assets.kick,
    assets.snare,
    assets.hat,
  ]);
}

export interface BasicMixOptions {
  /** The Hats track muted: what "Undo that" follows. */
  readonly hatsMuted?: boolean;
  /** A Reverb on the Snare track: what "Take the reverb off again" follows. */
  readonly snareReverb?: boolean;
}

/**
 * Seven tracks, each with a one-bar clip placed for 8 bars: Kick (at -2 dB),
 * Snare and Hats (one-pad drum machines), Bass, Guitar and Pad (synths) and
 * Vocals (a sampler). Every ID is made whatever the options, so the variants
 * share them.
 */
export function createBasicMixProject(options: BasicMixOptions = {}): Project {
  const context = evalContext("eval-basic-mix");
  const assets = kitAssets(context);
  const tracks = [
    onePadTrack(context, "Kick", 0, assets.kick.id, "Kick beat", [0, 4, 8, 12], -2),
    onePadTrack(context, "Snare", 1, assets.snare.id, "Backbeat", [4, 12]),
    onePadTrack(context, "Hats", 2, assets.hat.id, "Hat line", [2, 6, 10, 14]),
    pitchedTrack(context, "Bass", 3, "Bassline", BASSLINE),
    pitchedTrack(context, "Guitar", 4, "Strum", [
      [57, 0, 2 * QUARTER],
      [60, 0, 2 * QUARTER],
      [64, 0, 2 * QUARTER],
    ]),
    pitchedTrack(context, "Pad", 5, "Pad chords", [
      [69, 0, 4 * QUARTER],
      [72, 0, 4 * QUARTER],
    ]),
    pitchedTrack(context, "Vocals", 6, "Vocal line", VOCAL_LINE, { sampler: true }),
  ];
  const reverb = createDevice(context.ids("device"), "reverb", 0);
  const parts: Part[] = tracks.map(({ track, clip }) => {
    let next = track;
    if (track.name === "Hats" && options.hatsMuted) {
      next = { ...track, mixer: { ...track.mixer, muted: true } };
    }
    if (track.name === "Snare" && options.snareReverb)
      next = { ...track, devices: [reverb] };
    return { track: next, clips: [clip], placements: [placed(context, clip, 0, 8)] };
  });
  return build(context, "Mixdown", 120, parts, [assets.kick, assets.snare, assets.hat]);
}

/**
 * One drum machine, "Drums", with Kick, Snare and Hat pads playing a bar
 * placed for 4. The factory clap and a kick longer than the Kick pad's are in
 * the project's sounds but on no pad, so a clap pad or the Kick pad can point
 * at them: the assistant can only reach a sound the project holds.
 */
export function createBasicKitProject(): Project {
  const context = evalContext("eval-basic-kit");
  const assets = kitAssets(context);
  const drums = drumsPart(context, assets, 0, "Beat");
  const longKick = createFactoryAsset(context, "longKick");
  return build(
    context,
    "Kit",
    120,
    [{ ...drums, clips: [drums.clip], placements: [placed(context, drums.clip, 0, 4)] }],
    [assets.kick, assets.snare, assets.hat, assets.clap, longKick],
  );
}

/** A synth, "Synth", with a one-bar riff, beside a drum track. */
export function createBasicSynthProject(): Project {
  const context = evalContext("eval-basic-synth");
  const assets = kitAssets(context);
  const drums = drumsPart(context, assets, 0, "Beat");
  const synth = pitchedTrack(context, "Synth", 1, "Riff", [
    [57, 0, EIGHTH],
    [60, EIGHTH, EIGHTH],
    [64, 2 * EIGHTH, EIGHTH],
    [67, 3 * EIGHTH, EIGHTH],
  ]);
  const parts: Part[] = [
    { ...drums, clips: [drums.clip], placements: [placed(context, drums.clip, 0, 4)] },
    { ...synth, clips: [synth.clip], placements: [placed(context, synth.clip, 0, 4)] },
  ];
  return build(context, "Riff", 120, parts, [assets.kick, assets.snare, assets.hat]);
}

function chain(context: Context, types: readonly DeviceTypeId[]): Device[] {
  return types.map((type, order) => createDevice(context.ids("device"), type, order));
}

/** Vocals with a Reverb and then a Delay on them, beside a drum track. */
export function createBasicEffectsProject(): Project {
  const context = evalContext("eval-basic-effects");
  const assets = kitAssets(context);
  const drums = drumsPart(context, assets, 0, "Beat");
  const vocals = pitchedTrack(context, "Vocals", 1, "Vocal line", VOCAL_LINE, {
    sampler: true,
    devices: chain(context, ["reverb", "delay"]),
  });
  const parts: Part[] = [
    { ...drums, clips: [drums.clip], placements: [placed(context, drums.clip, 0, 4)] },
    { ...vocals, clips: [vocals.clip], placements: [placed(context, vocals.clip, 0, 4)] },
  ];
  return build(context, "Vocal chain", 120, parts, [
    assets.kick,
    assets.snare,
    assets.hat,
  ]);
}

/** A hat's nudge off the grid, by step: what "loose" hats are played with. */
const LOOSE_TICKS = [5, -7, 9, -4, 6, -9, 3, -6, 8, -5, 7, -3, 4, -8, 9, -6];

/**
 * Hats (a bar of 16ths at one velocity, on the grid or `loose` off it), a
 * Melody, a Bassline of 8ths and Chords, each one clip placed for 4 bars.
 */
export function createBasicNotesProject(loose = false): Project {
  const context = evalContext(loose ? "eval-basic-notes-loose" : "eval-basic-notes");
  const assets = kitAssets(context);
  const pad = createDrumPad(context, { name: "Hat", assetId: assets.hat.id });
  const hats = createTrack(context, {
    name: "Hats",
    order: 0,
    instrument: createDrumMachineInstrument([pad]),
  });
  const hatClip = createNoteClip(context, {
    trackId: hats.id,
    name: "Hats",
    lengthTicks: TICKS_PER_BAR,
    events: LOOSE_TICKS.map((nudge, step) =>
      createNoteEvent(context, {
        startTicks: Math.max(0, step * TICKS_PER_SIXTEENTH + (loose ? nudge : 0)),
        durationTicks: TICKS_PER_SIXTEENTH / 2,
        padId: pad.id,
        velocity: 0.7,
      }),
    ),
  });
  const melody = pitchedTrack(context, "Melody", 1, "Melody", [
    [72, 0, QUARTER],
    [74, QUARTER, QUARTER],
    [76, 2 * QUARTER, EIGHTH],
    [79, 2 * QUARTER + EIGHTH, EIGHTH],
    [77, 3 * QUARTER, QUARTER],
  ]);
  const bass = pitchedTrack(context, "Bass", 2, "Bassline", BASSLINE);
  const chords = pitchedTrack(context, "Chords", 3, "Chords", [
    [57, 0, 2 * QUARTER],
    [60, 0, 2 * QUARTER],
    [64, 0, 2 * QUARTER],
    [53, 2 * QUARTER, 2 * QUARTER],
    [57, 2 * QUARTER, 2 * QUARTER],
    [60, 2 * QUARTER, 2 * QUARTER],
  ]);
  const parts: Part[] = [
    { track: hats, clips: [hatClip], placements: [placed(context, hatClip, 0, 4)] },
    ...[melody, bass, chords].map(({ track, clip }) => ({
      track,
      clips: [clip],
      placements: [placed(context, clip, 0, 4)],
    })),
  ];
  return build(context, "Notes", 120, parts, [assets.hat]);
}
