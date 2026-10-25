/**
 * An `offer_takes` call (GRV-207) as the model sends it, for tests: four
 * takes of a lead melody, each a new "Lead" synth track with a one-bar clip
 * of compact notes placed at bar 1, in the IDs a turn given `stem` makes.
 * Every take makes the same track, as a model writing one part does; take
 * `n` (from 1) climbs from a different note.
 */
import {
  OFFER_TAKES_TOOL_NAME,
  type OfferTakesInput,
  TAKE_COUNT,
} from "../assistant/takes";
import type { Project } from "../domain/entities";

export const TAKE_LABELS = [
  "Sparse and low",
  "Busy and high",
  "Climbing line",
  "Lots of space",
] as const;

export const TAKES_STEM = "Stem0000000000000";

const id = (prefix: string, stem: string, n: number) =>
  `${prefix}_${stem}${String(n).padStart(4, "0")}`;

/** The track every take makes. */
export function takesTrackId(stem = TAKES_STEM): string {
  return id("trk", stem, 1);
}

/** One take's calls: the Lead track, a one-bar clip of compact notes on it, and its placement at bar 1. */
export function takeCalls(
  project: Project,
  take: number,
  stem = TAKES_STEM,
): OfferTakesInput["takes"][number]["calls"] {
  const trackId = takesTrackId(stem);
  const clipId = id("clp", stem, take);
  const root = 60 + take * 2;
  return [
    {
      name: "track_create",
      input: {
        id: trackId,
        name: "Lead",
        color: "#808080",
        order: project.song.tracks.length,
        type: "instrument",
        instrument: { kind: "synth", parameters: {} },
        devices: [],
        sendConfig: [],
        mixer: { volume: 0, pan: 0, muted: false, soloed: false },
      },
    },
    {
      name: "clip_create",
      input: {
        id: clipId,
        trackId,
        name: `Take ${take}`,
        color: "#808080",
        lengthTicks: 768,
        content: {
          kind: "notes",
          events: [
            [0, root, 192, 0.8],
            [192, root + 2, 192, 0.7],
            [384, root + 4, 384, 0.7],
          ],
        },
      },
    },
    {
      name: "placement_create",
      input: {
        id: id("plc", stem, take),
        clipId,
        trackId,
        startTicks: 0,
        durationTicks: 768,
        clipOffsetTicks: 0,
        looped: false,
      },
    },
  ];
}

/** The input of an offer of four takes, for `project`. */
export function offerTakesInput(project: Project, stem = TAKES_STEM): OfferTakesInput {
  return {
    part: "Lead melody",
    takes: Array.from({ length: TAKE_COUNT }, (_, index) => ({
      label: TAKE_LABELS[index],
      calls: takeCalls(project, index + 1, stem),
    })),
  };
}

/** The whole call, as the model sends it. */
export function offerTakesCall(project: Project, stem?: string) {
  return { name: OFFER_TAKES_TOOL_NAME, input: offerTakesInput(project, stem) };
}

/** The labels of the four drum-pattern takes (GRV-213). */
export const DRUM_TAKE_LABELS = [
  "Sparse half-time",
  "Busy straight sixteenths",
  "Swung shuffle",
  "Fill at the end",
] as const;

/** The drum machine every drum take makes, and its kick, snare and hat pads. */
export function drumTakesIds(stem = TAKES_STEM) {
  return {
    trackId: id("trk", stem, 1),
    kick: id("pad", stem, 1),
    snare: id("pad", stem, 2),
    hat: id("pad", stem, 3),
  };
}

/** Take `n`'s hits as compact notes: [startTicks, padId, durationTicks, velocity]. */
function drumHits(
  take: number,
  stem: string,
): (readonly [number, string, number, number])[] {
  const { kick, snare, hat } = drumTakesIds(stem);
  const at = (pad: string, sixteenths: readonly number[], velocity: number) =>
    sixteenths.map((step) => [step * 48, pad, 48, velocity] as const);
  switch (take) {
    case 1:
      return [
        ...at(kick, [0], 0.9),
        ...at(snare, [8], 0.8),
        ...at(hat, [0, 4, 8, 12], 0.5),
      ];
    case 2:
      return [
        ...at(kick, [0, 4, 8, 12], 0.9),
        ...at(snare, [4, 12], 0.8),
        ...at(hat, [...Array(16).keys()], 0.5),
      ];
    case 3:
      return [
        ...at(kick, [0, 7, 10], 0.9),
        ...at(snare, [4, 12], 0.8),
        ...at(hat, [0, 3, 4, 7, 8, 11, 12, 15], 0.6),
      ];
    default:
      return [
        ...at(kick, [0, 8], 0.9),
        ...at(snare, [4, 12, 13, 14, 15], 0.8),
        ...at(hat, [0, 2, 4, 6, 8, 10], 0.5),
      ];
  }
}

/**
 * One drum take's calls (GRV-213): a new "Drums" drum machine with kick,
 * snare and hat pads, a one-bar clip of hits on them, and its placement at
 * bar 1 looped over four bars, so the pattern is one bar of a longer part.
 */
export function drumTakeCalls(
  project: Project,
  take: number,
  stem = TAKES_STEM,
): OfferTakesInput["takes"][number]["calls"] {
  const ids = drumTakesIds(stem);
  const pad = (padId: string, name: string) => ({
    id: padId,
    name,
    assetId: null,
    chokeGroup: null,
    parameters: {},
    mixer: { volume: 0, pan: 0, muted: false, soloed: false },
  });
  const clipId = id("clp", stem, take);
  return [
    {
      name: "track_create",
      input: {
        id: ids.trackId,
        name: "Drums",
        color: "#808080",
        order: project.song.tracks.length,
        type: "instrument",
        instrument: {
          kind: "drumMachine",
          pads: [pad(ids.kick, "Kick"), pad(ids.snare, "Snare"), pad(ids.hat, "Hat")],
          parameters: {},
        },
        devices: [],
        sendConfig: [],
        mixer: { volume: 0, pan: 0, muted: false, soloed: false },
      },
    },
    {
      name: "clip_create",
      input: {
        id: clipId,
        trackId: ids.trackId,
        name: `Beat ${take}`,
        color: "#808080",
        lengthTicks: 768,
        content: { kind: "notes", events: drumHits(take, stem) },
      },
    },
    {
      name: "placement_create",
      input: {
        id: id("plc", stem, take),
        clipId,
        trackId: ids.trackId,
        startTicks: 0,
        durationTicks: 3072,
        clipOffsetTicks: 0,
        looped: true,
      },
    },
  ];
}

/** The input of an offer of four drum-pattern takes, for `project` (GRV-213). */
export function drumTakesInput(project: Project, stem = TAKES_STEM): OfferTakesInput {
  return {
    part: "Drum pattern",
    takes: Array.from({ length: TAKE_COUNT }, (_, index) => ({
      label: DRUM_TAKE_LABELS[index],
      calls: drumTakeCalls(project, index + 1, stem),
    })),
  };
}

/** The whole drum-pattern call, as the model sends it (GRV-213). */
export function drumTakesCall(project: Project, stem?: string) {
  return { name: OFFER_TAKES_TOOL_NAME, input: drumTakesInput(project, stem) };
}
