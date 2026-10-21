import { MAX_BARS, STEPS_PER_BAR } from "./stepEditorModel";

/**
 * The step grid's Generate panel maths (#643): what each generator writes into
 * one row.
 *
 * Pure and framework-free. A generator is a list of hits, each a 0-based step
 * and a velocity, through the clip's length; turning hits into the note
 * commands that replace a row is `generatedRow.ts`'s job.
 */

/** One step a generator turns on, and how hard. */
export interface Hit {
  readonly step: number;
  readonly velocity: number;
}

/** Generated velocity: on the beat, off it, and Euclidean's accented first hit. */
export const ON_BEAT_VELOCITY = 0.9;
export const OFF_BEAT_VELOCITY = 0.7;
export const ACCENT_VELOCITY = 1;

const STEPS_PER_BEAT = STEPS_PER_BAR / 4;

function beatVelocity(step: number): number {
  return step % STEPS_PER_BEAT === 0 ? ON_BEAT_VELOCITY : OFF_BEAT_VELOCITY;
}

// --- Patterns ---------------------------------------------------------------

export type PresetId =
  | "four_on_the_floor"
  | "offbeats"
  | "backbeat"
  | "eighths"
  | "sixteenths";

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  /** Whether the preset hits a step of the bar, 0-15. */
  hits(stepOfBar: number): boolean;
}

/** The five patterns, in the panel's order. Each repeats every bar. */
export const PRESETS: readonly Preset[] = [
  { id: "four_on_the_floor", label: "Four on the floor", hits: (s) => s % 4 === 0 },
  { id: "offbeats", label: "Offbeats", hits: (s) => s % 4 === 2 },
  { id: "backbeat", label: "Backbeat", hits: (s) => s % 8 === 4 },
  { id: "eighths", label: "Eighths", hits: (s) => s % 2 === 0 },
  { id: "sixteenths", label: "Sixteenths", hits: () => true },
];

/** A preset's hits through `steps` steps, bar after bar. */
export function presetHits(preset: Preset, steps: number): Hit[] {
  const hits: Hit[] = [];
  for (let step = 0; step < steps; step++) {
    if (preset.hits(step % STEPS_PER_BAR)) {
      hits.push({ step, velocity: beatVelocity(step) });
    }
  }
  return hits;
}

// --- Euclidean --------------------------------------------------------------

export interface EuclideanSettings {
  /** How many of the cycle's steps are hits, 0 to `steps`. */
  readonly hits: number;
  /** The cycle's length, 2 to 16. */
  readonly steps: number;
  /** How far the pattern is turned, 0 to `steps` - 1. */
  readonly rotate: number;
}

export const MIN_EUCLIDEAN_STEPS = 2;
export const MAX_EUCLIDEAN_STEPS = STEPS_PER_BAR;

function clampInt(value: number, low: number, high: number): number {
  const whole = Number.isFinite(value) ? Math.round(value) : low;
  return Math.min(high, Math.max(low, whole));
}

/** Settings pulled into range: Steps first, then Hits and Rotate against it. */
export function clampEuclidean(settings: EuclideanSettings): EuclideanSettings {
  const steps = clampInt(settings.steps, MIN_EUCLIDEAN_STEPS, MAX_EUCLIDEAN_STEPS);
  return {
    steps,
    hits: clampInt(settings.hits, 0, steps),
    rotate: clampInt(settings.rotate, 0, steps - 1),
  };
}

/**
 * One cycle of the Euclidean rhythm: `hits` spread as evenly as they go over
 * `steps`, starting on the first, then turned `rotate` steps later. 3 of 8 is
 * the tresillo, x..x..x.
 */
export function euclideanCycle(settings: EuclideanSettings): boolean[] {
  const { hits, steps, rotate } = clampEuclidean(settings);
  return Array.from({ length: steps }, (_, index) => {
    const turned = (((index - rotate) % steps) + steps) % steps;
    return (turned * hits) % steps < hits;
  });
}

/** The cycle repeated through `steps` steps, accenting each cycle's first hit. */
export function euclideanHits(settings: EuclideanSettings, steps: number): Hit[] {
  const cycle = euclideanCycle(settings);
  const first = cycle.indexOf(true);
  const hits: Hit[] = [];
  for (let step = 0; step < steps; step++) {
    const position = step % cycle.length;
    if (!cycle[position]) continue;
    hits.push({
      step,
      velocity: position === first ? ACCENT_VELOCITY : beatVelocity(step),
    });
  }
  return hits;
}

// --- Random -----------------------------------------------------------------

/** One throw per step of the longest clip, so a roll covers any clip. */
export const ROLL_LENGTH = MAX_BARS * STEPS_PER_BAR;

/** A fresh roll of the dice: one number in [0, 1) per step. */
export function newRoll(random: () => number = Math.random): number[] {
  return Array.from({ length: ROLL_LENGTH }, () => random());
}

/**
 * The steps whose throw falls under `density` (0 to 1). The roll is fixed, so
 * raising the density only ever adds hits.
 */
export function randomHits(
  roll: readonly number[],
  density: number,
  steps: number,
): Hit[] {
  const hits: Hit[] = [];
  for (let step = 0; step < Math.min(steps, roll.length); step++) {
    if (roll[step] < density) hits.push({ step, velocity: beatVelocity(step) });
  }
  return hits;
}
