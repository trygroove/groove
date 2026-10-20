/**
 * Clicking the ruler puts the playhead there (GRV-189). Framework-free: the
 * hit-test is `hitTestLoopBrace` (a press on the brace grabs it instead), and
 * this module only decides which tick a press elsewhere on the ruler means.
 *
 * The tick snaps to the arrangement's grid, the same lines the canvas draws
 * (`gridStepBars`, #1107), so a click lands on a line you can see. Alt skips
 * the snap and lands exactly where the pointer is.
 */

import { TICKS_PER_BAR } from "../domain/time";
import { gridStepBars } from "./canvasRenderer";

/** The tick of the grid line nearest `ticks`, never before the top of the song. */
export function snapToGrid(ticks: number, pixelsPerTick: number): number {
  const stepTicks = gridStepBars(TICKS_PER_BAR * pixelsPerTick) * TICKS_PER_BAR;
  return Math.max(0, Math.round(ticks / stepTicks) * stepTicks);
}

/** Where a ruler press at `pointerTicks` puts the playhead. */
export function rulerSeekTicks(
  pointerTicks: number,
  pixelsPerTick: number,
  exact: boolean,
): number {
  if (exact) return Math.max(0, Math.round(pointerTicks));
  return snapToGrid(pointerTicks, pixelsPerTick);
}
