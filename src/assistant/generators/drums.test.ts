import { describe, expect, it } from "vitest";
import {
  backbeat,
  DRUM_GRID_TICKS,
  euclidean,
  euclideanSteps,
  fourOnTheFloor,
  hats,
  varySteps,
} from "./drums";
import { seededRandom } from "./random";

const PAD = "pad_Kick00000000000000001";
const random = (seed = "seed") => seededRandom(seed);

describe("the drum generators at variation 0 (GRV-141)", () => {
  it("writes four on the floor as a hit on every beat, for the bars asked", () => {
    expect(fourOnTheFloor({ padId: PAD }, random())).toEqual({
      padId: PAD,
      steps: "x...x...x...x...",
      stepTicks: DRUM_GRID_TICKS,
    });
    expect(fourOnTheFloor({ padId: PAD, bars: 2 }, random()).steps).toBe(
      "x...x...x...x...".repeat(2),
    );
  });

  it("writes a backbeat on beats 2 and 4", () => {
    expect(backbeat({ padId: PAD }, random()).steps).toBe("....x.......x...");
  });

  it("writes hats at each rate", () => {
    expect(hats({ padId: PAD, rate: "8th" }, random()).steps).toBe("x.x.x.x.x.x.x.x.");
    expect(hats({ padId: PAD, rate: "16th" }, random()).steps).toBe("x".repeat(16));
    expect(hats({ padId: PAD, rate: "offbeat" }, random()).steps).toBe(
      "..x...x...x...x.",
    );
  });

  it("passes a step string's velocities through", () => {
    expect(
      fourOnTheFloor({ padId: PAD, velocity: { x: 90 } }, random()).velocity,
    ).toEqual({ x: 90 });
  });

  it("spreads Euclidean hits evenly, starting on one, and rotates them later", () => {
    expect(euclideanSteps(3, 8)).toBe("x..x..x.");
    expect(euclideanSteps(5, 8)).toBe("x.xx.xx.");
    expect(euclideanSteps(4, 16)).toBe("x...x...x...x...");
    expect(euclideanSteps(5, 16)).toBe("x..x..x..x..x...");
    expect(euclideanSteps(3, 8, 1)).toBe(".x..x..x");
    expect(euclideanSteps(3, 8, 9)).toBe(".x..x..x");
    expect(euclideanSteps(0, 8)).toBe("........");
    expect(euclideanSteps(8, 8)).toBe("xxxxxxxx");
    expect(
      euclidean({ padId: PAD, hits: 5, steps: 16, rotate: 2, stepTicks: 24 }, random()),
    ).toEqual({ padId: PAD, steps: "..x..x..x..x..x.", stepTicks: 24 });
  });

  it("is the same whatever the seed", () => {
    expect(fourOnTheFloor({ padId: PAD, bars: 4 }, random("a"))).toEqual(
      fourOnTheFloor({ padId: PAD, bars: 4 }, random("b")),
    );
  });
});

describe("the drum generators' variation (GRV-141)", () => {
  const varied = (seed: string, variation = 0.8) =>
    hats({ padId: PAD, rate: "16th", bars: 4, variation }, random(seed)).steps;

  it("is the same for the same seed", () => {
    expect(varied("turn:0:0")).toBe(varied("turn:0:0"));
  });

  it("differs for a different seed, and from the exact part", () => {
    expect(varied("turn:0:0")).not.toBe(varied("turn:1:0"));
    expect(varied("turn:0:0")).not.toBe("x".repeat(64));
  });

  it("moves velocities, drops hits and adds ghosts, never touching a bar's first step", () => {
    const steps = fourOnTheFloor(
      { padId: PAD, bars: 32, variation: 1 },
      random("busy"),
    ).steps;
    expect(steps).toHaveLength(32 * 16);
    expect(steps).toMatch(/[Xo]/);
    expect(steps).toMatch(/o/);
    for (let bar = 0; bar < 32; bar += 1) expect(steps[bar * 16]).not.toBe(".");
    // Drops: fewer beat hits than the exact part's 128.
    const beats = [...steps].filter((char, index) => index % 4 === 0 && char !== ".");
    expect(beats.length).toBeLessThan(128);
  });

  it("returns the steps as they are at 0, drawing nothing", () => {
    const source = random("untouched");
    expect(varySteps("x.x.", 0, source)).toBe("x.x.");
    expect(source.next()).toBe(random("untouched").next());
  });
});
