// How a command's one-line summary names a length, a position or a grid.
// Ticks are an internal unit that appears nowhere else in the interface, so an
// undo tip says bars, beats and steps (16ths) instead. The meter is fixed at
// four beats a bar in schema v1 (`BEATS_PER_BAR`), so no project is consulted.
import {
  BEATS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_QUARTER,
  TICKS_PER_SIXTEENTH,
  ticksToBarsBeatsSixteenths,
} from "../domain/time";

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

/** A span of time: "2 bars", "1 bar 2 beats", "3 steps". */
export function describeLength(ticks: number): string {
  const { bars, beats, sixteenths, ticks: rest } = ticksToBarsBeatsSixteenths(ticks);
  const parts: string[] = [];
  if (bars > 0) parts.push(plural(bars, "bar"));
  if (beats > 0) parts.push(plural(beats, "beat"));
  if (sixteenths > 0 || rest > 0) {
    const steps = sixteenths + rest / TICKS_PER_SIXTEENTH;
    parts.push(plural(Number(steps.toFixed(2)), "step"));
  }
  return parts.length > 0 ? parts.join(" ") : "no length";
}

/** A point on the timeline, counted from 1 as a producer reads it: "bar 3 beat 2". */
export function describePosition(ticks: number): string {
  const { bars, beats, sixteenths, ticks: rest } = ticksToBarsBeatsSixteenths(ticks);
  let text = `bar ${bars + 1}`;
  if (beats > 0 || sixteenths > 0 || rest > 0) text += ` beat ${beats + 1}`;
  if (sixteenths > 0 || rest > 0) {
    text += ` step ${Number((sixteenths + 1 + rest / TICKS_PER_SIXTEENTH).toFixed(2))}`;
  }
  return text;
}

/** A quantize grid as a note value: 48 ticks is "1/16", a whole bar is "1 bar". */
export function describeGrid(gridTicks: number): string {
  if (gridTicks === TICKS_PER_BAR) return "1 bar";
  const fraction = (TICKS_PER_QUARTER * BEATS_PER_BAR) / gridTicks;
  return Number.isInteger(fraction) ? `1/${fraction}` : describeLength(gridTicks);
}
