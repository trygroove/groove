import {
  DRAWING_SAMPLE_RATE,
  eqStageSettings,
  eqStagesResponseDb,
} from "../../audio/devices/eqResponse";
import { EQ_BANDS, type EqBand, eqBandHasGain } from "../../domain/devices";
import { frequencyAt, positionOf } from "../../instrument/filterResponse";

/**
 * The EQ well's geometry (LOOP-022): where a frequency and a gain sit on it,
 * where each band's handle is, and the path of the response curve. The curve
 * is `eqResponse.ts` — the engine's own stages and the Web Audio
 * specification's own maths — so what is drawn is what is heard.
 *
 * The axes are the filter well's log axis, 20 Hz to 20 kHz, and ±24 dB: room
 * for a band's full ±18 dB with the curve's resonant overshoot above it, and
 * enough below that a cut reads as falling away rather than as a line on the
 * floor.
 */

export const EQ_TOP_DB = 24;
export const EQ_BOTTOM_DB = -24;

type Values = Readonly<Record<string, number>>;

/** Where `db` sits down the well, 0 at the top and 1 at the bottom. */
export function dbDepth(db: number): number {
  const clamped = Math.min(EQ_TOP_DB, Math.max(EQ_BOTTOM_DB, db));
  return (EQ_TOP_DB - clamped) / (EQ_TOP_DB - EQ_BOTTOM_DB);
}

/** The gain at a height `y` up the well (0 bottom, 1 top). */
export function dbAt(y: number): number {
  return EQ_BOTTOM_DB + Math.min(1, Math.max(0, y)) * (EQ_TOP_DB - EQ_BOTTOM_DB);
}

/** SVG path data for the whole EQ's response across a `width` × `height` box. */
export function eqCurvePath(values: Values, width: number, height: number): string {
  const stages = eqStageSettings(values);
  const steps = 160;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const db = eqStagesResponseDb(stages, frequencyAt(i / steps), DRAWING_SAMPLE_RATE);
    const x = ((i / steps) * width).toFixed(1);
    points.push(`${i ? "L" : "M"}${x},${(dbDepth(db) * height).toFixed(1)}`);
  }
  return points.join(" ");
}

export interface EqHandle {
  readonly band: EqBand;
  /** Across the well, 0..1, left to right. */
  readonly x: number;
  /** Down the well, 0..1, top to bottom. */
  readonly y: number;
  readonly on: boolean;
}

/**
 * Each band's handle: at its frequency, and at its gain for a shelf or a
 * peak. A cut has no gain, so its handle sits on the 0 dB line, which is
 * where the curve leaves when the cut begins.
 */
export function eqHandles(values: Values): EqHandle[] {
  return EQ_BANDS.map((band) => ({
    band,
    x: positionOf(values[`${band.id}Freq`]),
    y: dbDepth(eqBandHasGain(band.kind) ? values[`${band.id}Gain`] : 0),
    on: values[`${band.id}On`] >= 0.5,
  }));
}

/**
 * The band whose handle is nearest a press at `point` (`y` measured up from
 * the bottom, as the drag surface reports it). `aspect` is the surface's width
 * over its height, so distance is measured as it looks on screen: a handle
 * above the press is not unfairly near or far.
 */
export function nearestBand(
  point: { readonly x: number; readonly y: number },
  handles: readonly EqHandle[],
  aspect: number,
): EqBand {
  let nearest = handles[0];
  let best = Number.POSITIVE_INFINITY;
  for (const handle of handles) {
    const distance = Math.hypot((handle.x - point.x) * aspect, 1 - handle.y - point.y);
    if (distance < best) {
      best = distance;
      nearest = handle;
    }
  }
  return nearest.band;
}

/** The level range the spectrum behind the curve is drawn across, in dBFS. */
export const SPECTRUM_TOP_DB = -12;
export const SPECTRUM_FLOOR_DB = -96;

/**
 * SVG path data for a live spectrum as an area rising from the well's floor,
 * on the curve's own log frequency axis. Each column takes the loudest bin it
 * covers, so a narrow peak is not lost between columns at the top end, and at
 * the bottom, where a column is narrower than a bin, it reads between the bins
 * either side.
 */
export function spectrumPath(
  reading: { readonly db: Float32Array; readonly binHz: number },
  width: number,
  height: number,
): string {
  const columns = 120;
  const last = reading.db.length - 1;
  const points: string[] = [`M0,${height}`];
  for (let i = 0; i <= columns; i++) {
    const low = Math.floor(frequencyAt((i - 0.5) / columns) / reading.binHz);
    const high = Math.ceil(frequencyAt((i + 0.5) / columns) / reading.binHz);
    let loudest = Number.NEGATIVE_INFINITY;
    if (high - low <= 2) {
      // Narrower than a bin or two: read between the two bins either side of
      // the column's own frequency, so the low end is a slope, not a stair.
      const at = Math.min(last, frequencyAt(i / columns) / reading.binHz);
      const below = Math.floor(at);
      const above = Math.min(last, below + 1);
      const t = at - below;
      const a = Math.max(SPECTRUM_FLOOR_DB, reading.db[below]);
      const b = Math.max(SPECTRUM_FLOOR_DB, reading.db[above]);
      loudest = a + (b - a) * t;
    } else {
      for (let bin = Math.max(0, low); bin <= Math.min(last, high); bin++) {
        loudest = Math.max(loudest, reading.db[bin]);
      }
    }
    const level = Math.min(SPECTRUM_TOP_DB, Math.max(SPECTRUM_FLOOR_DB, loudest));
    const depth = (SPECTRUM_TOP_DB - level) / (SPECTRUM_TOP_DB - SPECTRUM_FLOOR_DB);
    points.push(`L${((i / columns) * width).toFixed(1)},${(depth * height).toFixed(1)}`);
  }
  points.push(`L${width},${height} Z`);
  return points.join(" ");
}
