import { describe, expect, it } from "vitest";
import { defaultDeviceParameters, EQ_BANDS } from "../../domain/devices";
import { positionOf } from "../../instrument/filterResponse";
import {
  dbAt,
  dbDepth,
  eqCurvePath,
  eqHandles,
  nearestBand,
  SPECTRUM_FLOOR_DB,
  spectrumPath,
} from "./eqCurve";

const values = (overrides: Record<string, number> = {}) => ({
  ...defaultDeviceParameters("eq"),
  ...overrides,
});

describe("EQ curve geometry (LOOP-022)", () => {
  it("maps a gain down the well and back", () => {
    expect(dbDepth(0)).toBe(0.5);
    expect(dbDepth(24)).toBe(0);
    expect(dbDepth(-60)).toBe(1);
    for (const db of [-18, -6, 0, 3, 18])
      expect(dbAt(1 - dbDepth(db))).toBeCloseTo(db, 9);
  });

  it("draws a fresh EQ as a flat line at 0 dB", () => {
    const ys = [...eqCurvePath(values(), 300, 100).matchAll(/,([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(ys.length).toBeGreaterThan(100);
    expect(new Set(ys)).toEqual(new Set([50]));
  });

  it("draws a boost above the 0 dB line where it is", () => {
    const path = eqCurvePath(values({ peak1Freq: 1_000, peak1Gain: 12 }), 300, 100);
    const points = [...path.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    const highest = points.reduce((a, b) => (b.y < a.y ? b : a));
    expect(highest.x / 300).toBeCloseTo(positionOf(1_000), 1);
    expect(highest.y).toBeCloseTo(dbDepth(12) * 100, 0);
  });

  it("puts each handle at its band's frequency and gain, a cut's on 0 dB", () => {
    const handles = eqHandles(values({ lowShelfGain: -6, lowCutFreq: 50 }));
    expect(handles.map((h) => h.band.id)).toEqual(EQ_BANDS.map((b) => b.id));
    const lowShelf = handles[1];
    expect(lowShelf.x).toBeCloseTo(positionOf(120), 9);
    expect(lowShelf.y).toBeCloseTo(dbDepth(-6), 9);
    expect(handles[0]).toMatchObject({ y: 0.5, on: false });
    expect(handles[0].x).toBeCloseTo(positionOf(50), 9);
    expect(handles[2].on).toBe(true);
  });

  it("picks the band whose handle is nearest the press", () => {
    const handles = eqHandles(values());
    // A press right on the 3 kHz peak, and one a little above the 8 kHz shelf.
    // The well is three times as wide as it is tall.
    expect(nearestBand({ x: positionOf(3_000), y: 0.5 }, handles, 3).id).toBe("peak2");
    expect(nearestBand({ x: positionOf(8_000), y: 0.7 }, handles, 3).id).toBe(
      "highShelf",
    );
    expect(nearestBand({ x: 0, y: 0.5 }, handles, 3).id).toBe("lowCut");
  });

  it("measures the distance to a handle as the surface is drawn", () => {
    const [, , peak1, peak2] = EQ_BANDS;
    const handles = [
      // Just right of the press but well above it, and further right at its height.
      { band: peak1, x: 0.5, y: 0.2, on: true },
      { band: peak2, x: 0.6, y: 0.5, on: true },
    ];
    const press = { x: 0.52, y: 0.5 };
    // On a square surface the handle at the press's height is nearer; on a
    // wide one, a step across is long and the handle just right of it wins.
    expect(nearestBand(press, handles, 1).id).toBe("peak2");
    expect(nearestBand(press, handles, 10).id).toBe("peak1");
  });

  it("draws silence as nothing above the floor", () => {
    const silent = { db: new Float32Array(1024).fill(-Infinity), binHz: 23.4375 };
    const ys = [...spectrumPath(silent, 300, 100).matchAll(/,([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(new Set(ys)).toEqual(new Set([100]));
  });

  it("draws a tone's spectrum peaking where the tone is", () => {
    const binHz = 23.4375;
    const db = new Float32Array(1024).fill(SPECTRUM_FLOOR_DB - 10);
    db[Math.round(1_000 / binHz)] = -20;
    const points = [
      ...spectrumPath({ db, binHz }, 300, 100).matchAll(/L([\d.]+),([\d.]+)/g),
    ]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
      .filter((p) => p.y < 100);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.x / 300).toBeCloseTo(positionOf(1_000), 1);
    }
  });
});
