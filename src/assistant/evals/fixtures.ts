/**
 * The projects the assistant's musical evals run against (GRV-6).
 *
 * Built from the domain factories and the factory library, never written out
 * as literals, and seeded, so every run of an eval sends the model the same
 * project with the same IDs. Every sound is a bundled factory asset
 * (`createFactoryAsset`), so check 2 can hold a proposal to the library.
 *
 * - {@link createKitSketchProject}: a drum machine with four factory pads and
 *   one "kit check" bar that hits each of them once, and nothing else: the
 *   blank page a loop sketch starts from.
 * - {@link createHouseLoopProject}: a one-bar house loop on four tracks
 *   (drums, bass, chords, lead), placed for four bars: what a variation, a
 *   balance or a processing request works on.
 * - {@link createArrangementProject}: the same loop under an empty
 *   intro / build / drop / outro form, laid out for 32 bars.
 */
import type {
  Clip,
  NoteEvent,
  Placement,
  Project,
  Section,
  Song,
  Track,
} from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createEmptySong,
  createFactoryContext,
  createNewProjectMaster,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createProjectMetadata,
  createSection,
  createSynthInstrument,
  createTrack,
  type DomainFactoryContext,
} from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import { derivePackDependencies } from "../../domain/packs";
import { assertProject } from "../../domain/parse";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import { createFactoryAsset } from "../../library/factoryLibrary";

const SIXTEENTH = TICKS_PER_SIXTEENTH;
const EIGHTH = 2 * TICKS_PER_SIXTEENTH;
const QUARTER = 4 * TICKS_PER_SIXTEENTH;

/** The fixed moment every fixture is created at. */
const FIXTURE_NOW = 1_760_000_000_000;

function evalContext(seed: string): DomainFactoryContext {
  return createFactoryContext({ ids: createSeededIdFactory(seed), now: FIXTURE_NOW });
}

/** The drum machine every fixture plays: four pads on the factory kit. */
function drumKit(context: DomainFactoryContext) {
  const kick = createFactoryAsset(context, "starterKick");
  const clap = createFactoryAsset(context, "starterClap");
  const snare = createFactoryAsset(context, "starterSnare");
  const hat = createFactoryAsset(context, "starterHat");
  const pads = {
    kick: createDrumPad(context, { name: "Kick", assetId: kick.id }),
    clap: createDrumPad(context, { name: "Clap", assetId: clap.id }),
    snare: createDrumPad(context, { name: "Snare", assetId: snare.id }),
    hat: createDrumPad(context, { name: "Hat", assetId: hat.id }),
  };
  const track = createTrack(context, {
    name: "Drums",
    order: 0,
    instrument: createDrumMachineInstrument(Object.values(pads)),
  });
  return { track, pads, assets: [kick, clap, snare, hat] };
}

type Kit = ReturnType<typeof drumKit>;

function hits(
  context: DomainFactoryContext,
  padId: Kit["pads"]["kick"]["id"],
  sixteenths: readonly number[],
  velocity = 0.8,
): NoteEvent[] {
  return sixteenths.map((step) =>
    createNoteEvent(context, {
      startTicks: step * SIXTEENTH,
      durationTicks: SIXTEENTH,
      padId,
      velocity,
    }),
  );
}

function notes(
  context: DomainFactoryContext,
  events: readonly (readonly [pitch: number, start: number, duration: number])[],
  velocity = 0.75,
): NoteEvent[] {
  return events.map(([pitch, startTicks, durationTicks]) =>
    createNoteEvent(context, { pitch, startTicks, durationTicks, velocity }),
  );
}

function project(
  context: DomainFactoryContext,
  name: string,
  song: Song,
  clips: readonly Clip[],
): Project {
  return assertProject({
    metadata: createProjectMetadata(context, {
      ownerId: "user_eval",
      name,
      template: null,
      packDependencies: derivePackDependencies(song),
    }),
    song,
    clips,
  });
}

/** A drum machine and one bar that hits each pad once, selected for a sketch. */
export function createKitSketchProject(): Project {
  const context = evalContext("eval-kit-sketch");
  const kit = drumKit(context);
  const clip = createNoteClip(context, {
    trackId: kit.track.id,
    name: "Kit check",
    lengthTicks: TICKS_PER_BAR,
    events: [
      ...hits(context, kit.pads.kick.id, [0]),
      ...hits(context, kit.pads.clap.id, [4]),
      ...hits(context, kit.pads.snare.id, [8]),
      ...hits(context, kit.pads.hat.id, [12]),
    ],
  });
  const placement = createPlacement(context, {
    clipId: clip.id,
    trackId: kit.track.id,
    startTicks: 0,
    durationTicks: TICKS_PER_BAR,
  });
  const song: Song = {
    ...createEmptySong(120),
    master: createNewProjectMaster(context),
    tracks: [kit.track],
    placements: [placement],
    assets: kit.assets,
  };
  return project(context, "Sketchpad", song, [clip]);
}

interface Loop {
  readonly context: DomainFactoryContext;
  readonly tracks: readonly Track[];
  readonly clips: readonly Clip[];
  readonly assets: Song["assets"];
  readonly master: Song["master"];
}

/** The one-bar house loop both loop fixtures share, unplaced. */
function houseLoop(seed: string): Loop {
  const context = evalContext(seed);
  const kit = drumKit(context);
  const bass = createTrack(context, {
    name: "Bass",
    order: 1,
    instrument: createSynthInstrument(),
  });
  const chords = createTrack(context, {
    name: "Chords",
    order: 2,
    instrument: createSynthInstrument(),
  });
  const lead = createTrack(context, {
    name: "Lead",
    order: 3,
    instrument: createSynthInstrument(),
  });

  const drumClip = createNoteClip(context, {
    trackId: kit.track.id,
    name: "House beat",
    lengthTicks: TICKS_PER_BAR,
    events: [
      ...hits(context, kit.pads.kick.id, [0, 4, 8, 12], 0.9),
      ...hits(context, kit.pads.clap.id, [4, 12], 0.8),
      ...hits(context, kit.pads.hat.id, [2, 6, 10, 14], 0.6),
    ],
  });
  // A minor: an offbeat octave bassline.
  const bassClip = createNoteClip(context, {
    trackId: bass.id,
    name: "Offbeat bass",
    lengthTicks: TICKS_PER_BAR,
    events: notes(context, [
      [33, EIGHTH, EIGHTH],
      [45, 3 * EIGHTH, EIGHTH],
      [33, 5 * EIGHTH, EIGHTH],
      [43, 7 * EIGHTH, EIGHTH],
    ]),
  });
  // Am7 then Fmaj7, two beats each.
  const chordClip = createNoteClip(context, {
    trackId: chords.id,
    name: "Stabs",
    lengthTicks: TICKS_PER_BAR,
    events: notes(
      context,
      [
        ...[57, 60, 64, 67].map((pitch) => [pitch, 0, 2 * QUARTER] as const),
        ...[53, 57, 60, 64].map((pitch) => [pitch, 2 * QUARTER, 2 * QUARTER] as const),
      ],
      0.6,
    ),
  });
  const leadClip = createNoteClip(context, {
    trackId: lead.id,
    name: "Hook",
    lengthTicks: TICKS_PER_BAR,
    events: notes(context, [
      [76, 0, EIGHTH],
      [74, EIGHTH, EIGHTH],
      [72, QUARTER, QUARTER],
      [69, 3 * QUARTER, QUARTER],
    ]),
  });
  return {
    context,
    tracks: [kit.track, bass, chords, lead],
    clips: [drumClip, bassClip, chordClip, leadClip],
    assets: kit.assets,
    master: createNewProjectMaster(context),
  };
}

function loopPlacements(loop: Loop, startBar: number, lengthBars: number): Placement[] {
  return loop.clips.map((clip) =>
    createPlacement(loop.context, {
      clipId: clip.id,
      trackId: clip.trackId,
      startTicks: startBar * TICKS_PER_BAR,
      durationTicks: lengthBars * TICKS_PER_BAR,
      looped: true,
    }),
  );
}

/** A one-bar house loop on four tracks, looped for four bars. */
export function createHouseLoopProject(): Project {
  const loop = houseLoop("eval-house-loop");
  const song: Song = {
    ...createEmptySong(124),
    master: loop.master,
    tracks: [...loop.tracks],
    placements: loopPlacements(loop, 0, 4),
    assets: loop.assets,
  };
  return project(loop.context, "Night Bus", song, loop.clips);
}

/**
 * The house loop under an empty song form: an 8-bar intro, an 8-bar build, a
 * 16-bar drop and an 8-bar outro, with the loop placed only in the first four
 * bars. Arranging it is the request.
 */
export function createArrangementProject(): Project {
  const loop = houseLoop("eval-arrangement");
  const form: readonly (readonly [name: string, startBar: number, bars: number])[] = [
    ["Intro", 0, 8],
    ["Build", 8, 8],
    ["Drop", 16, 16],
    ["Outro", 32, 8],
  ];
  const sections: Section[] = form.map(([name, startBar, length]) =>
    createSection(loop.context, {
      name,
      startTicks: startBar * TICKS_PER_BAR,
      durationTicks: length * TICKS_PER_BAR,
    }),
  );
  const song: Song = {
    ...createEmptySong(124),
    master: loop.master,
    tracks: [...loop.tracks],
    sections,
    placements: loopPlacements(loop, 0, 4),
    assets: loop.assets,
  };
  return project(loop.context, "Night Bus", song, loop.clips);
}
