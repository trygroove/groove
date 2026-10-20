import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR } from "../domain/time";
import { rulerSeekTicks, snapToGrid } from "./rulerSeek";

// 100px per bar: a grid line every bar.
const ZOOMED_IN = 100 / TICKS_PER_BAR;
// 10px per bar: lines every 4 bars (>= 40px apart).
const ZOOMED_OUT = 10 / TICKS_PER_BAR;

describe("rulerSeekTicks", () => {
  it("snaps to the nearest bar line when every bar has a grid line", () => {
    expect(rulerSeekTicks(TICKS_PER_BAR * 1.4, ZOOMED_IN, false)).toBe(TICKS_PER_BAR);
    expect(rulerSeekTicks(TICKS_PER_BAR * 1.6, ZOOMED_IN, false)).toBe(2 * TICKS_PER_BAR);
  });

  it("snaps to the coarser grid the canvas draws when zoomed out", () => {
    expect(snapToGrid(TICKS_PER_BAR * 5, ZOOMED_OUT)).toBe(4 * TICKS_PER_BAR);
    expect(snapToGrid(TICKS_PER_BAR * 1, ZOOMED_OUT)).toBe(0);
  });

  it("lands exactly where the pointer is when exact (Alt)", () => {
    expect(rulerSeekTicks(TICKS_PER_BAR * 1.4 + 0.3, ZOOMED_IN, true)).toBe(
      Math.round(TICKS_PER_BAR * 1.4),
    );
  });

  it("never goes before the top of the song", () => {
    expect(rulerSeekTicks(-50, ZOOMED_IN, false)).toBe(0);
    expect(rulerSeekTicks(-50, ZOOMED_IN, true)).toBe(0);
  });
});
