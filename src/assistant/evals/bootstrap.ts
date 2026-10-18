/**
 * The paired bootstrap an experiment's verdict rests on (GRV-110).
 *
 * Each case gives one difference, the variant's figure minus the control's,
 * both taken over that case's runs. The interval is the percentile bootstrap
 * of their mean, resampling *cases* with replacement: a case is the unit
 * that varies between experiments, and two runs of one case are not two
 * independent samples of the suite. It is seeded, so the same report always
 * gives the same interval.
 */

/** A seeded uniform generator in [0, 1) (mulberry32): small, fast, and the same everywhere. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface ConfidenceInterval {
  readonly low: number;
  readonly high: number;
  /** The share of resampled means it covers, e.g. 0.95. */
  readonly level: number;
}

export interface BootstrapOptions {
  readonly resamples?: number;
  readonly level?: number;
  readonly seed?: number;
}

export const DEFAULT_BOOTSTRAP: Required<BootstrapOptions> = {
  resamples: 4_000,
  level: 0.95,
  seed: 110,
};

export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The percentile bootstrap interval of the mean of `differences`, one per
 * case; null when there are none. One case gives an interval of its own
 * difference alone.
 */
export function pairedBootstrap(
  differences: readonly number[],
  options: BootstrapOptions = {},
): ConfidenceInterval | null {
  const { resamples, level, seed } = { ...DEFAULT_BOOTSTRAP, ...options };
  const n = differences.length;
  if (n === 0) return null;
  const random = seededRandom(seed);
  const means = new Array<number>(resamples);
  for (let sample = 0; sample < resamples; sample += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) {
      sum += differences[Math.floor(random() * n)];
    }
    means[sample] = sum / n;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const at = (q: number) =>
    means[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))];
  return { low: at(tail), high: at(1 - tail), level };
}

/**
 * Which way an interval says a change went, for a number where higher (or
 * lower) is better: `better` or `worse` when it lies wholly on one side of
 * zero, `inconclusive` when it crosses or touches it.
 */
export function intervalOutcome(
  interval: ConfidenceInterval | null,
  higherIsBetter: boolean,
): "better" | "worse" | "inconclusive" {
  if (!interval) return "inconclusive";
  if (interval.low > 0) return higherIsBetter ? "better" : "worse";
  if (interval.high < 0) return higherIsBetter ? "worse" : "better";
  return "inconclusive";
}
