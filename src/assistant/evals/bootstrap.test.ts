import { describe, expect, it } from "vitest";
import { intervalOutcome, pairedBootstrap, seededRandom } from "./bootstrap";

describe("pairedBootstrap (GRV-110)", () => {
  it("gives the same interval for the same differences, every time", () => {
    const sample = [-1200, -800, -950, -300, -1500, 100];
    const interval = pairedBootstrap(sample);
    expect(pairedBootstrap(sample)).toEqual(interval);
    // Pinned on the fixed sample and seed: about the mean of -775, give or
    // take twice its standard error (about 230), as a normal interval would be.
    expect(interval).toEqual({
      low: -1175,
      high: -333.3333333333333,
      level: 0.95,
    });
    expect(intervalOutcome(interval, false)).toBe("better");
    expect(intervalOutcome(interval, true)).toBe("worse");
  });

  it("crosses zero for differences either side of it", () => {
    const interval = pairedBootstrap([-0.2, 0.15, -0.05, 0.1, 0.0]);
    expect(interval?.low).toBeLessThan(0);
    expect(interval?.high).toBeGreaterThan(0);
    expect(intervalOutcome(interval, true)).toBe("inconclusive");
  });

  it("is a point for one case or for no change, and touching zero is inconclusive", () => {
    expect(pairedBootstrap([-400])).toEqual({ low: -400, high: -400, level: 0.95 });
    const none = pairedBootstrap([0, 0, 0]);
    expect(none).toEqual({ low: 0, high: 0, level: 0.95 });
    expect(intervalOutcome(none, false)).toBe("inconclusive");
    expect(pairedBootstrap([])).toBeNull();
    expect(intervalOutcome(null, false)).toBe("inconclusive");
  });

  it("widens with the level asked for", () => {
    const sample = [3, 1, 4, 1, 5, 9, 2, 6];
    const narrow = pairedBootstrap(sample, { level: 0.5 });
    const wide = pairedBootstrap(sample, { level: 0.99 });
    expect(wide?.low ?? 0).toBeLessThan(narrow?.low ?? 0);
    expect(wide?.high ?? 0).toBeGreaterThan(narrow?.high ?? 0);
  });

  it("draws from a seeded generator in [0, 1)", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
  });
});
