import { describe, expect, it } from "vitest";
import { ASSISTANT_MODELS } from "../config";
import { SpendTally } from "./budget";

describe("SpendTally (GRV-110)", () => {
  it("sums each turn's cost, and lets no turn start that would be expected to pass the budget", () => {
    const tally = new SpendTally(1);
    // Nothing has reported yet: there is no mean to project from.
    expect(tally.canStart(9)).toBe(true);
    tally.add(0.2);
    tally.add(0.2);
    expect(tally.spentUsd).toBeCloseTo(0.4);
    expect(tally.meanTurnUsd).toBeCloseTo(0.2);
    // $0.40 spent; one more at $0.20 is $0.60, with two in flight $1.00.
    expect(tally.canStart(0)).toBe(true);
    expect(tally.canStart(2)).toBe(true);
    expect(tally.canStart(3)).toBe(false);
    tally.add(0.2);
    tally.add(0.2);
    expect(tally.canStart(0)).toBe(true);
    tally.add(0.2);
    // Exactly at the budget: it stops.
    expect(tally.spentUsd).toBeCloseTo(1);
    expect(tally.canStart(0)).toBe(false);
  });

  it("projects at the dearest turn so far, not the mean", () => {
    const tally = new SpendTally(1);
    tally.add(0.1);
    tally.add(0.5);
    // Mean $0.30 would let one more start ($0.90); the dearest, $0.50, does not.
    expect(tally.meanTurnUsd).toBeCloseTo(0.3);
    expect(tally.canStart(0)).toBe(false);
  });

  it("stops once the spend alone reaches the budget", () => {
    const tally = new SpendTally(0.5);
    tally.add(0.6);
    expect(tally.canStart(0)).toBe(false);
  });

  it("prices a turn by its usage, and counts a turn with none as free and unpriced", () => {
    const tally = new SpendTally(25);
    tally.addUsage(ASSISTANT_MODELS["claude-sonnet-5"], {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // $2 per million input, $10 per million output.
    expect(tally.spentUsd).toBeCloseTo(3);
    tally.addUsage(ASSISTANT_MODELS["claude-sonnet-5"], null);
    expect(tally.meanTurnUsd).toBeCloseTo(3);
  });

  it("refuses a budget of nothing", () => {
    expect(() => new SpendTally(0)).toThrow(RangeError);
  });
});
