import { describe, expect, it } from "vitest";
import {
  compressorOutput,
  delayEchoes,
  delayTime,
  overdriveTransfer,
  REVERB_WINDOW,
  reverbTailPath,
  reverbTiming,
  saturatorTransfer,
  transferPath,
} from "./deviceDrawings";

describe("device drawings (#447)", () => {
  it("drives an overdrive harder, and clips its negative half sooner", () => {
    // Clean at zero drive is close to the bare curve; more drive, more squash.
    expect(overdriveTransfer(0, 0)).toBe(0);
    expect(Math.abs(overdriveTransfer(1, 0.05))).toBeGreaterThan(
      Math.abs(overdriveTransfer(0, 0.05)),
    );
    // Both halves start at unity (#925); the negative one bends away sooner
    // and tops out lower, which is the asymmetry that gives it even harmonics.
    expect(Math.abs(overdriveTransfer(0, -0.5))).toBeLessThan(overdriveTransfer(0, 0.5));
    expect(Math.abs(overdriveTransfer(0.5, -0.3))).toBeLessThan(
      overdriveTransfer(0.5, 0.3),
    );
  });

  it("draws an overdrive at drive 0 as unity near zero, rounded past full scale (#925)", () => {
    expect(overdriveTransfer(0, 0.01)).toBeCloseTo(0.01, 4);
    expect(overdriveTransfer(0, -0.01)).toBeCloseTo(-0.01, 4);
    const hot = overdriveTransfer(0, 1.4);
    expect(hot).toBeGreaterThan(overdriveTransfer(0, 1));
    expect(hot).toBeLessThan(1);
  });

  it("morphs a saturator from a soft knee to a fold with its character", () => {
    const soft = saturatorTransfer(12, 0, 0.9);
    const fold = saturatorTransfer(12, 1, 0.9);
    expect(soft).toBeGreaterThan(0);
    // Past its peak the fold turns back on itself.
    expect(fold).toBeLessThan(soft);
    expect(saturatorTransfer(0, 0, 0)).toBe(0);
  });

  it("draws a saturator at 0 dB drive as unity near zero, rounded past full scale (#885)", () => {
    for (const character of [0, 1]) {
      expect(saturatorTransfer(0, character, 0.01)).toBeCloseTo(0.01, 5);
    }
    const hot = saturatorTransfer(0, 0, 1.4);
    expect(hot).toBeGreaterThan(saturatorTransfer(0, 0, 1));
    expect(hot).toBeLessThan(1);
    // The fold is not silent at or above full scale.
    expect(saturatorTransfer(0, 1, 1)).toBeGreaterThan(0.5);
    expect(saturatorTransfer(0, 1, 1.4)).toBeGreaterThan(0.5);
  });

  it("draws a transfer across the box, clamped inside it", () => {
    const ys = transferPath((x) => 3 * x, 300, 100)
      .split(" ")
      .map((point) => Number(point.slice(1).split(",")[1]));
    expect(ys).toHaveLength(121);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(100);
  });

  it("scales a reverb's pre-delay and decay with its size, as the engine does", () => {
    expect(reverbTiming(2, 0, 0.01)).toEqual({ predelay: 0.01, decay: 1 });
    expect(reverbTiming(2, 1, 0.01)).toEqual({
      predelay: expect.closeTo(0.06, 5),
      decay: 3,
    });
  });

  it("ramps the tail down from the end of the pre-delay to the end of the decay", () => {
    // Pre-delay 0.5 s + 25 ms of size; decay 2 s × (0.5 + 0.5) = 2 s.
    expect(reverbTailPath(2, 0.5, 0.5, REVERB_WINDOW * 10, 100)).toBe(
      "M5.3,100 L5.3,5.0 L25.3,100.0 L25.3,100 Z",
    );
  });

  it("cuts a tail longer than the window where it leaves", () => {
    const path = reverbTailPath(30, 1, 0, 80, 100);
    expect(path).toContain("L80.0,");
    expect(path).not.toContain("L80.0,100.0");
  });
});

describe("compressor and delay drawings (#447)", () => {
  it("passes below the threshold and divides by the ratio above it", () => {
    expect(compressorOutput(-40, -20, 4, 0)).toBe(-40);
    expect(compressorOutput(0, -20, 4, 0)).toBe(-15);
    expect(compressorOutput(0, -20, 4, 6)).toBe(-9);
    // Inside the knee the curve bends between the two, continuously.
    const inKnee = compressorOutput(-20, -20, 4, 0);
    expect(inKnee).toBeLessThan(-20);
    expect(inKnee).toBeGreaterThan(-20 - 3);
  });

  it("times a synced delay from the tempo and a free one from its seconds", () => {
    expect(delayTime(true, 0.3, 1 / 4, 120)).toBe(0.5);
    expect(delayTime(true, 0.3, 1 / 8, 60)).toBe(0.5);
    expect(delayTime(false, 0.3, 1 / 4, 120)).toBe(0.3);
  });

  it("repeats each side at its own interval, falling by the feedback", () => {
    const echoes = delayEchoes(0.5, 0.5, 1);
    expect(echoes.filter((e) => e.side === "left").map((e) => [e.at, e.level])).toEqual([
      [0.5, 1],
      [1, 0.5],
      [1.5, 0.25],
      [2, 0.125],
    ]);
    expect(echoes.filter((e) => e.side === "right").map((e) => e.at)).toEqual([1, 2]);
    expect(delayEchoes(0, 0.5, 0)).toEqual([]);
  });
});
