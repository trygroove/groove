import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, TICKS_PER_QUARTER, TICKS_PER_SIXTEENTH } from "../domain/time";
import { describeGrid, describeLength, describePosition } from "./musicalWording";

describe("musical wording for command summaries", () => {
  it("names a length in bars, beats and steps, never ticks", () => {
    expect(describeLength(TICKS_PER_BAR)).toBe("1 bar");
    expect(describeLength(2 * TICKS_PER_BAR)).toBe("2 bars");
    expect(describeLength(4 * TICKS_PER_BAR)).toBe("4 bars");
    expect(describeLength(TICKS_PER_BAR + 2 * TICKS_PER_QUARTER)).toBe("1 bar 2 beats");
    expect(describeLength(3 * TICKS_PER_SIXTEENTH)).toBe("3 steps");
  });

  it("names a position counted from 1", () => {
    expect(describePosition(0)).toBe("bar 1");
    expect(describePosition(2 * TICKS_PER_BAR)).toBe("bar 3");
    expect(describePosition(TICKS_PER_BAR + TICKS_PER_QUARTER)).toBe("bar 2 beat 2");
    expect(describePosition(TICKS_PER_QUARTER + TICKS_PER_SIXTEENTH)).toBe(
      "bar 1 beat 2 step 2",
    );
  });

  it("names a quantize grid as a note value", () => {
    expect(describeGrid(TICKS_PER_SIXTEENTH)).toBe("1/16");
    expect(describeGrid(TICKS_PER_QUARTER)).toBe("1/4");
    expect(describeGrid(TICKS_PER_BAR)).toBe("1 bar");
  });
});
