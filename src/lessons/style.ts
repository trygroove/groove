/**
 * Which beat the "Make a beat" chapter teaches (GRV-43): its pattern, tempo
 * and wording follow the producer's genre from memory. House and techno
 * learn four on the floor, hip hop boom bap, trap trap; anyone else starts
 * on four on the floor, the plainest of the three.
 *
 * Every pattern is one bar of sixteen steps, numbered from 0 here and from 1
 * on screen.
 */

export const BEAT_STYLES = ["four_on_the_floor", "boom_bap", "trap"] as const;
export type BeatStyle = (typeof BEAT_STYLES)[number];

export interface BeatPattern {
  /** What the style is called, as a term the producer can tap (`glossary.ts`). */
  readonly term: string;
  readonly termId: string;
  /** A tempo it sits well at, in BPM. */
  readonly tempo: number;
  /** The steps the kick must hit. */
  readonly kick: readonly number[];
  /** The steps the snare (or clap) must hit. */
  readonly snare: readonly number[];
  /** The steps the hats must hit. */
  readonly hats: readonly number[];
  /** The backbeat's sound: a clap for house, a snare otherwise. */
  readonly snareSound: "clap" | "snare";
}

export const BEAT_PATTERNS: Readonly<Record<BeatStyle, BeatPattern>> = {
  four_on_the_floor: {
    term: "four on the floor",
    termId: "four-on-the-floor",
    tempo: 124,
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hats: [2, 6, 10, 14],
    snareSound: "clap",
  },
  boom_bap: {
    term: "boom bap",
    termId: "boom-bap",
    tempo: 90,
    kick: [0, 10],
    snare: [4, 12],
    hats: [0, 2, 4, 6, 8, 10, 12, 14],
    snareSound: "snare",
  },
  trap: {
    term: "trap",
    termId: "trap",
    tempo: 140,
    kick: [0, 6],
    snare: [8],
    hats: [0, 2, 4, 6, 8, 10, 12, 14],
    snareSound: "snare",
  },
};

const BOOM_BAP = /hip.?hop|boom.?bap|lo.?fi|jazz|soul|r&b|rap/i;
const TRAP = /trap|drill/i;

/**
 * The style for a producer who loves `taste`: the first genre that names one
 * decides it, so "Trap, House" learns trap.
 */
export function beatStyleFor(taste: readonly string[]): BeatStyle {
  for (const genre of taste) {
    if (TRAP.test(genre)) return "trap";
    if (BOOM_BAP.test(genre)) return "boom_bap";
    if (/house|techno|disco|dance|electro|garage|edm/i.test(genre)) {
      return "four_on_the_floor";
    }
  }
  return "four_on_the_floor";
}

/** Steps as the step grid numbers them: from 1, joined for a sentence. */
export function stepList(steps: readonly number[]): string {
  const shown = steps.map((step) => String(step + 1));
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}
