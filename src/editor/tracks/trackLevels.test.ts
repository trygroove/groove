import { createEffect, createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { TrackId } from "../../domain/ids";
import {
  CLIP_HOLD_FRAMES,
  createMasterLevel,
  createTrackLevels,
  nextTrackLevel,
} from "./trackLevels";

describe("nextTrackLevel (#447)", () => {
  it("clips on a peak over 0 dBFS, whatever the RMS", () => {
    const { level, holdLeft } = nextTrackLevel({ rmsDb: -3, peakDb: 0.2 }, 0);
    expect(level).toEqual({ db: -3, clipping: true });
    expect(holdLeft).toBe(CLIP_HOLD_FRAMES);
  });

  it("does not clip at exactly full scale", () => {
    expect(nextTrackLevel({ rmsDb: -3, peakDb: 0 }, 0).level.clipping).toBe(false);
  });

  it("holds a clip for a moment after the last over, then lets it go", () => {
    let hold = nextTrackLevel({ rmsDb: -3, peakDb: 1 }, 0).holdLeft;
    for (let frame = 1; frame < CLIP_HOLD_FRAMES; frame++) {
      const next = nextTrackLevel({ rmsDb: -20, peakDb: -12 }, hold);
      expect(next.level.clipping).toBe(true);
      hold = next.holdLeft;
    }
    expect(nextTrackLevel({ rmsDb: -20, peakDb: -12 }, hold).level.clipping).toBe(false);
  });
});

describe("createTrackLevels (#447)", () => {
  const A = "trk_a" as TrackId;
  const B = "trk_b" as TrackId;

  it("shows each track's frame, and rests every meter on clear", () => {
    createRoot((dispose) => {
      const levels = createTrackLevels();
      expect(levels.level(A)).toBeNull();

      levels.sample(
        new Map([
          [A, { rmsDb: -12, peakDb: -3 }],
          [B, { rmsDb: -6, peakDb: 0.5 }],
        ]),
      );
      flush();
      expect(levels.level(A)).toEqual({ db: -12, clipping: false });
      expect(levels.level(B)).toEqual({ db: -6, clipping: true });

      // A track that leaves the graph leaves the meters.
      levels.sample(new Map([[A, { rmsDb: -10, peakDb: -3 }]]));
      flush();
      expect(levels.level(B)).toBeNull();

      levels.clear();
      flush();
      expect(levels.level(A)).toBeNull();
      dispose();
    });
  });

  it("wakes a meter only when its own level changes", () => {
    createRoot((dispose) => {
      const levels = createTrackLevels();
      const frame = (a: number, b: number) =>
        levels.sample(
          new Map([
            [A, { rmsDb: a, peakDb: -20 }],
            [B, { rmsDb: b, peakDb: -20 }],
          ]),
        );
      frame(-12, -12);
      flush();
      const runs = vi.fn();
      createEffect(
        () => levels.level(A),
        () => runs(),
      );
      flush();
      runs.mockClear();

      frame(-12, -6);
      flush();
      expect(runs).not.toHaveBeenCalled();
      frame(-9, -6);
      flush();
      expect(runs).toHaveBeenCalledTimes(1);
      dispose();
    });
  });
});

describe("createMasterLevel (GRV-44)", () => {
  it("shows the mix's frame, holds a clip as a track's meter does, and rests on clear", () => {
    const master = createMasterLevel();
    expect(master.level()).toBeNull();

    master.sample({ rmsDb: -9, peakDb: -3 });
    flush();
    expect(master.level()).toEqual({ db: -9, clipping: false });

    master.sample({ rmsDb: -4, peakDb: 0.5 });
    flush();
    expect(master.level()).toEqual({ db: -4, clipping: true });
    // The clip stays lit after the over, so a single one is seen.
    master.sample({ rmsDb: -20, peakDb: -12 });
    flush();
    expect(master.level()?.clipping).toBe(true);

    master.clear();
    flush();
    expect(master.level()).toBeNull();
    // A clear drops the hold too: the next quiet frame is not red.
    master.sample({ rmsDb: -20, peakDb: -12 });
    flush();
    expect(master.level()).toEqual({ db: -20, clipping: false });
  });

  it("wakes its readers only when the level changes", () => {
    const master = createMasterLevel();
    const seen = vi.fn();
    const dispose = createRoot((done) => {
      createEffect(master.level, seen);
      return done;
    });
    flush();
    seen.mockClear();
    master.sample({ rmsDb: -9, peakDb: -3 });
    flush();
    flush();
    master.sample({ rmsDb: -9, peakDb: -6 });
    flush();
    flush();
    expect(seen).toHaveBeenCalledTimes(1);
    dispose();
  });
});
