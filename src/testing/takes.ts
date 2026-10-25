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
