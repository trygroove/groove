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
 * - {@link createTechnoDrumsProject} (GRV-99): a 140 BPM techno beat, one
 *   drum machine with five pads (kick, clap, closed hat, open hat, perc)
 *   playing one 4-bar clip, placed looped.
 * - {@link createTechnoLoopProject} (GRV-99): that beat plus one synth track
 *   with a 4-bar riff: the loop a producer wants to develop into a track.
 * - {@link createBdOnlyProject} (GRV-107): only the "BD" drum-machine track, as
 *   GRV-6's QA used it, at a chosen volume.
 * - {@link createBdSketchProject} (GRV-107): that track after an applied
 *   sketch: BD plus bass, chords, melody and texture tracks, each with a clip.
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

/** The techno fixtures' tempo. */
export const TECHNO_TEMPO = 140;

const TECHNO_BARS = 4;

/** Every bar of `bars`, with `sixteenths` offset into each one. */
function everyBar(sixteenths: readonly number[], bars = TECHNO_BARS): number[] {
  return Array.from({ length: bars }, (_, bar) =>
    sixteenths.map((step) => bar * 16 + step),
  ).flat();
}

/**
 * The techno beat: five pads on the factory kit (the open hat shares the
 * closed hat's sample, and the perc the snare's) and one 4-bar clip of a
 * plain four-on-the-floor groove with offbeat hats, placed looped for its
 * length.
 */
function technoDrums(context: DomainFactoryContext) {
  const kick = createFactoryAsset(context, "starterKick");
  const clap = createFactoryAsset(context, "starterClap");
  const snare = createFactoryAsset(context, "starterSnare");
  const hat = createFactoryAsset(context, "starterHat");
  const pads = {
    kick: createDrumPad(context, { name: "Kick", assetId: kick.id }),
    clap: createDrumPad(context, { name: "Clap", assetId: clap.id }),
    closedHat: createDrumPad(context, {
      name: "Closed Hat",
      assetId: hat.id,
      chokeGroup: 1,
    }),
    openHat: createDrumPad(context, { name: "Open Hat", assetId: hat.id, chokeGroup: 1 }),
    perc: createDrumPad(context, { name: "Perc", assetId: snare.id }),
  };
  const track = createTrack(context, {
    name: "Drums",
    order: 0,
    instrument: createDrumMachineInstrument(Object.values(pads)),
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: "Techno beat",
    lengthTicks: TECHNO_BARS * TICKS_PER_BAR,
    events: [
      ...hits(context, pads.kick.id, everyBar([0, 4, 8, 12]), 0.9),
      ...hits(context, pads.clap.id, everyBar([4, 12]), 0.75),
      ...hits(context, pads.closedHat.id, everyBar([2, 6, 10, 14]), 0.6),
      // An open hat at the end of every second bar.
      ...hits(context, pads.openHat.id, [16 + 14, 48 + 14], 0.55),
      ...hits(context, pads.perc.id, everyBar([7]), 0.5),
    ],
  });
  const placement = createPlacement(context, {
    clipId: clip.id,
    trackId: track.id,
    startTicks: 0,
    durationTicks: TECHNO_BARS * TICKS_PER_BAR,
    looped: true,
  });
  return { track, clip, placement, assets: [kick, clap, snare, hat] };
}

/** One drum machine with five pads playing a 4-bar techno beat at 140 BPM. */
export function createTechnoDrumsProject(): Project {
  const context = evalContext("eval-techno-drums");
  const drums = technoDrums(context);
  const song: Song = {
    ...createEmptySong(TECHNO_TEMPO),
    master: createNewProjectMaster(context),
    tracks: [drums.track],
    placements: [drums.placement],
    assets: drums.assets,
  };
  return project(context, "Warehouse", song, [drums.clip]);
}

/**
 * The techno beat plus a synth riff: a one-bar A minor figure, played four
 * times across its 4-bar clip with the last bar lifted, placed looped.
 */
export function createTechnoLoopProject(): Project {
  const context = evalContext("eval-techno-loop");
  const drums = technoDrums(context);
  const synth = createTrack(context, {
    name: "Synth",
    order: 1,
    instrument: createSynthInstrument(),
  });
  const figure = (bar: number, root: number) =>
    [0, 3, 6, 10, 14].map(
      (step, index) =>
        [
          index === 2 ? root + 12 : root,
          (bar * 16 + step) * SIXTEENTH,
          SIXTEENTH,
        ] as const,
    );
  const riff = createNoteClip(context, {
    trackId: synth.id,
    name: "Riff",
    lengthTicks: TECHNO_BARS * TICKS_PER_BAR,
    events: notes(context, [
      ...figure(0, 45),
      ...figure(1, 45),
      ...figure(2, 45),
      ...figure(3, 48),
    ]),
  });
  const riffPlacement = createPlacement(context, {
    clipId: riff.id,
    trackId: synth.id,
    startTicks: 0,
    durationTicks: TECHNO_BARS * TICKS_PER_BAR,
    looped: true,
  });
  const song: Song = {
    ...createEmptySong(TECHNO_TEMPO),
    master: createNewProjectMaster(context),
    tracks: [drums.track, synth],
    placements: [drums.placement, riffPlacement],
    assets: drums.assets,
  };
  return project(context, "Warehouse", song, [drums.clip, riff]);
}

/** The one-pad drum machine track QA used, named "BD". */
function bdTrack(context: DomainFactoryContext, volume: number) {
  const kick = createFactoryAsset(context, "starterKick");
  const pad = createDrumPad(context, { name: "BD", assetId: kick.id });
  const track = createTrack(context, {
    name: "BD",
    order: 0,
    volume,
    instrument: createDrumMachineInstrument([pad]),
  });
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: "BD hit",
    lengthTicks: TICKS_PER_BAR,
    events: hits(context, pad.id, [0, 4, 8, 12], 0.9),
  });
  return { track, pad, clip, asset: kick };
}

/**
 * Only the BD drum-machine track, at `volumeDb` (0 dB unless said), with a
 * bar of kicks placed for four bars: what QA sent its requests against.
 */
export function createBdOnlyProject(volumeDb = 0): Project {
  const context = evalContext("eval-bd-only");
  const bd = bdTrack(context, volumeDb);
  const song: Song = {
    ...createEmptySong(120),
    master: createNewProjectMaster(context),
    tracks: [bd.track],
    placements: [
      createPlacement(context, {
        clipId: bd.clip.id,
        trackId: bd.track.id,
        startTicks: 0,
        durationTicks: 4 * TICKS_PER_BAR,
        looped: true,
      }),
    ],
    assets: [bd.asset],
  };
  return project(context, "BD only", song, [bd.clip]);
}

/**
 * The BD track after an applied house sketch: bass, chords, melody and
 * texture synth tracks beside it, each with a one-bar clip placed for four.
 */
export function createBdSketchProject(): Project {
  const context = evalContext("eval-bd-sketch");
  const bd = bdTrack(context, 0);
  const parts: readonly (readonly [
    name: string,
    events: readonly (readonly [pitch: number, start: number, duration: number])[],
  ])[] = [
    [
      "Bass",
      [
        [33, EIGHTH, EIGHTH],
        [33, 3 * EIGHTH, EIGHTH],
        [36, 5 * EIGHTH, EIGHTH],
      ],
    ],
    [
      "Chords",
      [
        [57, 0, 2 * QUARTER],
        [60, 0, 2 * QUARTER],
        [64, 0, 2 * QUARTER],
      ],
    ],
    [
      "Melody",
      [
        [72, 0, EIGHTH],
        [76, QUARTER, EIGHTH],
        [74, 2 * QUARTER, QUARTER],
      ],
    ],
    [
      "Texture",
      [
        [81, 0, 4 * QUARTER],
        [84, 0, 4 * QUARTER],
      ],
    ],
  ];
  const synths = parts.map(([name, events], index) => {
    const track = createTrack(context, {
      name,
      order: index + 1,
      instrument: createSynthInstrument(),
    });
    const clip = createNoteClip(context, {
      trackId: track.id,
      name,
      lengthTicks: TICKS_PER_BAR,
      events: notes(context, events),
    });
    return { track, clip };
  });
  const clips = [bd.clip, ...synths.map((part) => part.clip)];
  const song: Song = {
    ...createEmptySong(124),
    master: createNewProjectMaster(context),
    tracks: [bd.track, ...synths.map((part) => part.track)],
    placements: clips.map((clip) =>
      createPlacement(context, {
        clipId: clip.id,
        trackId: clip.trackId,
        startTicks: 0,
        durationTicks: 4 * TICKS_PER_BAR,
        looped: true,
      }),
    ),
    assets: [bd.asset],
  };
  return project(context, "House sketch", song, clips);
}
