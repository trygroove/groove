/**
 * What the shaping and space devices do to a sound, as curves for their wells
 * (#447). Each mirrors its engine in `src/audio/devices` — the same transfer
 * functions, gains and size scaling — so the drawing is the sound's shape, not
 * an illustration. Most are written out here because the engine's own copies
 * live inside Tone node factories the editor cannot import; the Overdrive's
 * and the Saturator's live in Tone-free modules both sides import.
 */

/** The Overdrive's curve has no Tone in it, so this is the engine's own copy. */
export { overdriveTransfer } from "../../audio/devices/overdriveCurves";
/** The Saturator's curves have no Tone in them, so this is the engine's own copy. */
export { saturatorTransfer } from "../../audio/devices/saturatorCurves";

/** SVG path of `transfer` over -1..1 in a `width` × `height` box, clamped. */
export function transferPath(
  transfer: (x: number) => number,
  width: number,
  height: number,
): string {
  const steps = 120;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 2 - 1;
    const y = Math.max(-1, Math.min(1, transfer(x)));
    points.push(
      `${i ? "L" : "M"}${((i / steps) * width).toFixed(1)},${(((1 - y) / 2) * height).toFixed(1)}`,
    );
  }
  return points.join(" ");
}

/** How long a reverb's tail is shown for, in seconds. */
export const REVERB_WINDOW = 8;

/** The pre-delay and decay the reverb engine actually uses (size scales both). */
export function reverbTiming(decay: number, size: number, predelay: number) {
  return {
    predelay: predelay + size * 0.05,
    decay: Math.max(0.001, decay * (0.5 + size)),
  };
}

/**
 * The tail's level as an SVG area, in decibels so a 60 dB fall reads as the
 * straight ramp it is: silence through the pre-delay, full level, then down to
 * the floor at the end of the decay.
 */
export function reverbTailPath(
  decay: number,
  size: number,
  predelay: number,
  width: number,
  height: number,
): string {
  const timing = reverbTiming(decay, size, predelay);
  const x = (t: number) =>
    ((Math.min(t, REVERB_WINDOW) / REVERB_WINDOW) * width).toFixed(1);
  const end = timing.predelay + timing.decay;
  // Past the window the ramp is cut where it leaves, at the level it has then.
  const exitLevel =
    end > REVERB_WINDOW ? 1 - (REVERB_WINDOW - timing.predelay) / timing.decay : 0;
  const top = (height * 0.05).toFixed(1);
  return [
    `M${x(timing.predelay)},${height}`,
    `L${x(timing.predelay)},${top}`,
    `L${x(end)},${(height - Math.max(0, exitLevel) * height * 0.95).toFixed(1)}`,
    `L${x(end)},${height} Z`,
  ].join(" ");
}

/** The compressor's input and output range drawn, in dB. */
export const COMPRESSOR_FLOOR_DB = -60;
export const COMPRESSOR_CEILING_DB = 24;
/** The engine's fixed knee width (`compressor.ts`), in dB. */
const KNEE_DB = 6;

/**
 * Output level for a steady input at `inputDb`: unity below the threshold,
 * `ratio`:1 above it through a quadratic soft knee, plus makeup — the static
 * curve a DynamicsCompressorNode with a 6 dB knee follows.
 */
export function compressorOutput(
  inputDb: number,
  thresholdDb: number,
  ratio: number,
  makeupDb: number,
): number {
  const over = inputDb - thresholdDb;
  let out: number;
  if (2 * over < -KNEE_DB) out = inputDb;
  else if (2 * Math.abs(over) <= KNEE_DB) {
    out = inputDb + ((1 / ratio - 1) * (over + KNEE_DB / 2) ** 2) / (2 * KNEE_DB);
  } else out = thresholdDb + over / ratio;
  return out + makeupDb;
}

/** Position (0..1) of a level along the compressor well's axes. */
export function compressorPosition(db: number, floor = COMPRESSOR_FLOOR_DB, ceiling = 0) {
  return (db - floor) / (ceiling - floor);
}

/** SVG path of the compressor's curve across the well. */
export function compressorPath(
  thresholdDb: number,
  ratio: number,
  makeupDb: number,
  width: number,
  height: number,
): string {
  const points: string[] = [];
  for (let db = COMPRESSOR_FLOOR_DB; db <= 0; db += 0.5) {
    const out = compressorOutput(db, thresholdDb, ratio, makeupDb);
    const y = 1 - compressorPosition(out, COMPRESSOR_FLOOR_DB, COMPRESSOR_CEILING_DB);
    points.push(
      `${points.length ? "L" : "M"}${(compressorPosition(db) * width).toFixed(1)},${(Math.min(1, y) * height).toFixed(1)}`,
    );
  }
  return points.join(" ");
}

/** How long a delay's echoes are shown for, in seconds. */
export const DELAY_WINDOW = 2;

/** The delay time the engine uses (`delay.ts` `delaySeconds`). */
export function delayTime(
  sync: boolean,
  seconds: number,
  wholeNotes: number,
  tempo: number,
): number {
  if (!sync) return Math.max(0, Math.min(seconds, 4));
  const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
  return (240 / bpm) * wholeNotes;
}

export interface Echo {
  /** When it sounds, in seconds after the note. */
  readonly at: number;
  /** Its level, 1 for the first echo. */
  readonly level: number;
  readonly side: "left" | "right";
}

/**
 * Each echo in the window: the left line repeats every `time`, the right
 * every `time × (1 + spread)`, each falling by `feedback` per repeat.
 */
export function delayEchoes(time: number, feedback: number, spread: number): Echo[] {
  const echoes: Echo[] = [];
  if (time <= 0) return echoes;
  for (const [side, step] of [
    ["left", time],
    ["right", time * (1 + spread)],
  ] as const) {
    for (let n = 1; n * step <= DELAY_WINDOW && n <= 32; n++) {
      echoes.push({ at: n * step, level: feedback ** (n - 1), side });
    }
  }
  return echoes;
}
