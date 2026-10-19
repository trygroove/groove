/**
 * The drum pattern generators (GRV-141): common drum parts the model names
 * instead of writing out, each a pure function of primitive parameters that
 * returns a drum step string (GRV-140, `../drumSteps.ts`) for the gateway's
 * existing expansion to turn into notes.
 *
 * - `fourOnTheFloor(padId, bars)`: a hit on every beat.
 * - `backbeat(padId, bars)`: a hit on beats 2 and 4.
 * - `hats(padId, rate, bars)`: 8ths, 16ths, or the offbeat 8ths.
 * - `euclidean(padId, hits, steps, rotate, stepTicks)`: `hits` spread as evenly
 *   as they go over `steps`, moved `rotate` steps later.
 *
 * Each takes an optional `variation` (0 to 1): above 0 it turns the occasional
 * hit into an accent or a ghost, drops the occasional hit (never a bar's
 * first step) and adds the occasional ghost on a rest, drawing on the
 * call's seeded randomness. At 0 the string is exact.
 *
 * Pure, with no Tone, Firebase or Solid.
 */
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import type { DrumSteps } from "../drumSteps";
import type { SeededRandom } from "./random";

/** The 16th grid every bar-long drum generator writes on. */
export const DRUM_GRID_TICKS = TICKS_PER_SIXTEENTH;

/** Steps in a bar on that grid. */
const STEPS_PER_BAR = TICKS_PER_BAR / DRUM_GRID_TICKS;

/** How often, at `variation: 1`, a hit's velocity moves, a hit drops, and a rest gains a ghost. */
const MOVE_CHANCE = 0.35;
const DROP_CHANCE = 0.12;
const ADD_CHANCE = 0.08;

/**
 * A step string a drum generator makes, as the model would write one
 * (`DrumSteps`, its pad ID not yet checked): the note expander checks it
 * against the track's pads as it writes it out.
 */
export interface GeneratedSteps {
  readonly padId: string;
  readonly steps: string;
  readonly stepTicks: number;
  readonly velocity?: DrumSteps["velocity"];
}

/** What the bar-long drum generators share. */
export interface DrumPartInput {
  readonly padId: string;
  /** Bars the part runs for before it repeats; 1 when not given. */
  readonly bars?: number;
  readonly velocity?: DrumSteps["velocity"];
  readonly variation?: number;
}

export const HAT_RATES = ["8th", "16th", "offbeat"] as const;
export type HatRate = (typeof HAT_RATES)[number];

/** One bar of 16ths: `unit` repeated until the bar is full. */
function fillBar(unit: string): string {
  return unit.repeat(STEPS_PER_BAR / unit.length);
}

const HAT_BARS: Readonly<Record<HatRate, string>> = {
  "8th": fillBar("x."),
  "16th": fillBar("x"),
  offbeat: fillBar("..x."),
};

/**
 * `steps` with the occasional hit moved, dropped or added, `variation` saying
 * how occasional; the steps in `keep` are never dropped. Returns `steps` as it
 * is at 0, drawing nothing from `random`.
 */
export function varySteps(
  steps: string,
  variation: number,
  random: SeededRandom,
  keep: (index: number) => boolean = () => false,
): string {
  if (variation <= 0) return steps;
  return [...steps]
    .map((char, index) => {
      if (char === ".") return random.chance(ADD_CHANCE * variation) ? "o" : ".";
      if (!keep(index) && random.chance(DROP_CHANCE * variation)) return ".";
      if (!random.chance(MOVE_CHANCE * variation)) return char;
      if (char === "x") return random.next() < 0.5 ? "X" : "o";
      return "x";
    })
    .join("");
}

/** A bar-long pattern repeated over `bars` bars and varied, as a step string on the 16th grid. */
function barPart(
  bar: string,
  input: DrumPartInput,
  random: SeededRandom,
): GeneratedSteps {
  const bars = input.bars ?? 1;
  const steps = varySteps(
    bar.repeat(bars),
    input.variation ?? 0,
    random,
    (index) => index % STEPS_PER_BAR === 0,
  );
  return part(input.padId, steps, DRUM_GRID_TICKS, input.velocity);
}

function part(
  padId: string,
  steps: string,
  stepTicks: number,
  velocity: DrumSteps["velocity"],
): GeneratedSteps {
  return velocity === undefined
    ? { padId, steps, stepTicks }
    : { padId, steps, stepTicks, velocity };
}

/** A hit on every beat. */
export function fourOnTheFloor(
  input: DrumPartInput,
  random: SeededRandom,
): GeneratedSteps {
  return barPart(fillBar("x..."), input, random);
}

/** A hit on beats 2 and 4. */
export function backbeat(input: DrumPartInput, random: SeededRandom): GeneratedSteps {
  return barPart(fillBar("....x..."), input, random);
}

/** Closed hats at a rate: every 8th, every 16th, or only the 8ths between the beats. */
export function hats(
  input: DrumPartInput & { readonly rate: HatRate },
  random: SeededRandom,
): GeneratedSteps {
  return barPart(HAT_BARS[input.rate], input, random);
}

export interface EuclideanInput {
  readonly padId: string;
  readonly hits: number;
  readonly steps: number;
  /** Steps every hit moves later, wrapping round; 0 when not given. */
  readonly rotate?: number;
  /** Each step's length; a 16th when not given. */
  readonly stepTicks?: number;
  readonly velocity?: DrumSteps["velocity"];
  readonly variation?: number;
}

/**
 * The Euclidean rhythm E(hits, steps) by Bjorklund's algorithm: the hits
 * spread as evenly as whole steps allow, starting on one, in the order
 * Toussaint's tables give (E(3, 8) is `x..x..x.`, E(5, 8) `x.xx.xx.`).
 * `rotate` moves every hit that many steps later. The caller checks
 * `hits <= steps`.
 */
export function euclideanSteps(hits: number, steps: number, rotate = 0): string {
  let groups = Array.from({ length: hits }, () => "x");
  let rest = Array.from({ length: steps - hits }, () => ".");
  while (rest.length > 1 && groups.length > 0) {
    const paired = Math.min(groups.length, rest.length);
    const joined = groups.slice(0, paired).map((group, index) => group + rest[index]);
    rest = groups.length > paired ? groups.slice(paired) : rest.slice(paired);
    groups = joined;
  }
  const base = [...[...groups, ...rest].join("")];
  const shift = ((rotate % steps) + steps) % steps;
  return base.map((_, index) => base[(index - shift + steps) % steps]).join("");
}

/** `hits` spread evenly over `steps` steps of `stepTicks`, one cycle that repeats. */
export function euclidean(input: EuclideanInput, random: SeededRandom): GeneratedSteps {
  const steps = varySteps(
    euclideanSteps(input.hits, input.steps, input.rotate ?? 0),
    input.variation ?? 0,
    random,
  );
  return part(input.padId, steps, input.stepTicks ?? DRUM_GRID_TICKS, input.velocity);
}
