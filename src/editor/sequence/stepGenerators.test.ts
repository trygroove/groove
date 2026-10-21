import { describe, expect, it } from "vitest";
import {
  ACCENT_VELOCITY,
  clampEuclidean,
  euclideanCycle,
  euclideanHits,
  type Hit,
  newRoll,
  OFF_BEAT_VELOCITY,
  ON_BEAT_VELOCITY,
  PRESETS,
  type PresetId,
  presetHits,
  ROLL_LENGTH,
  randomHits,
} from "./stepGenerators";

const steps = (hits: readonly Hit[]) => hits.map((hit) => hit.step + 1);
const preset = (id: PresetId) => {
  const found = PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the step grid's pattern presets (#643)", () => {
  it("writes each preset's steps of the bar, in the panel's order", () => {
    expect(PRESETS.map((candidate) => candidate.label)).toEqual([
      "Four on the floor",
      "Offbeats",
      "Backbeat",
      "Eighths",
      "Sixteenths",
    ]);
    expect(steps(presetHits(preset("four_on_the_floor"), 16))).toEqual([1, 5, 9, 13]);
    expect(steps(presetHits(preset("offbeats"), 16))).toEqual([3, 7, 11, 15]);
    expect(steps(presetHits(preset("backbeat"), 16))).toEqual([5, 13]);
    expect(steps(presetHits(preset("eighths"), 16))).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(presetHits(preset("sixteenths"), 16)).toHaveLength(16);
  });

  it("repeats every bar through the clip", () => {
    expect(steps(presetHits(preset("backbeat"), 32))).toEqual([5, 13, 21, 29]);
  });

  it("writes 0.9 on the beat and 0.7 off it", () => {
    const eighths = presetHits(preset("eighths"), 8);
    expect(eighths.map((hit) => hit.velocity)).toEqual([
      ON_BEAT_VELOCITY,
      OFF_BEAT_VELOCITY,
      ON_BEAT_VELOCITY,
      OFF_BEAT_VELOCITY,
    ]);
  });
});

describe("the Euclidean generator (#643)", () => {
  it("spreads k hits over n steps, starting on the first", () => {
    expect(euclideanCycle({ hits: 3, steps: 8, rotate: 0 })).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(
      euclideanCycle({ hits: 4, steps: 16, rotate: 0 }).filter(Boolean),
    ).toHaveLength(4);
    expect(euclideanCycle({ hits: 0, steps: 5, rotate: 0 })).not.toContain(true);
    expect(euclideanCycle({ hits: 5, steps: 5, rotate: 0 })).not.toContain(false);
  });

  it("rotates the cycle later by Rotate steps", () => {
    const hitsAt = (rotate: number) =>
      euclideanCycle({ hits: 3, steps: 8, rotate }).flatMap((on, i) => (on ? [i] : []));
    expect(hitsAt(1)).toEqual([1, 4, 7]);
    expect(hitsAt(2)).toEqual([0, 2, 5]);
  });

  it("repeats the n-step cycle through the clip, as CF-020 reads it", () => {
    expect(steps(euclideanHits({ hits: 3, steps: 8, rotate: 0 }, 16))).toEqual([
      1, 4, 7, 9, 12, 15,
    ]);
    expect(steps(euclideanHits({ hits: 2, steps: 5, rotate: 0 }, 16))).toEqual([
      1, 4, 6, 9, 11, 14, 16,
    ]);
  });

  it("accents each cycle's first hit", () => {
    const hits = euclideanHits({ hits: 3, steps: 8, rotate: 0 }, 16);
    expect(hits[0].velocity).toBe(ACCENT_VELOCITY);
    expect(hits[3].velocity).toBe(ACCENT_VELOCITY);
    expect(hits[1].velocity).toBe(OFF_BEAT_VELOCITY);
  });

  it("keeps Steps in 2-16, Hits in 0-Steps and Rotate in 0-(Steps-1)", () => {
    expect(clampEuclidean({ hits: 9, steps: 40, rotate: 20 })).toEqual({
      hits: 9,
      steps: 16,
      rotate: 15,
    });
    expect(clampEuclidean({ hits: 5, steps: 1, rotate: -1 })).toEqual({
      hits: 2,
      steps: 2,
      rotate: 0,
    });
    expect(clampEuclidean({ hits: Number.NaN, steps: 8, rotate: 0 }).hits).toBe(0);
  });
});

describe("the Random generator (#643)", () => {
  const roll = newRoll(
    (() => {
      let seed = 7;
      return () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
    })(),
  );

  it("throws one number per step of the longest clip", () => {
    expect(roll).toHaveLength(ROLL_LENGTH);
  });

  it("only adds hits as density rises, over the same roll", () => {
    let previous: number[] = [];
    for (const density of [0, 0.1, 0.35, 0.6, 0.9, 1]) {
      const current = steps(randomHits(roll, density, 64));
      expect(current).toEqual(expect.arrayContaining(previous));
      expect(current.length).toBeGreaterThanOrEqual(previous.length);
      previous = current;
    }
    expect(randomHits(roll, 0, 64)).toEqual([]);
    expect(randomHits(roll, 1, 64)).toHaveLength(64);
  });

  it("changes with a new roll", () => {
    const other = newRoll(() => 0.99);
    expect(randomHits(other, 0.5, 16)).toEqual([]);
    expect(
      randomHits(
        newRoll(() => 0),
        0.5,
        16,
      ),
    ).toHaveLength(16);
  });
});
