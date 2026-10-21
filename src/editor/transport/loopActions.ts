import type { Analytics } from "../../analytics/analytics";
import { barAlignedLoop } from "../../audio/Transport";
import {
  type RawCommandInput,
  setLoopEnabled,
  setLoopRange,
  type TransactionResult,
} from "../../commands";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";

/**
 * The editor's two loop actions (PRD AUD-02, LOOP-017): toggle looping, and
 * set the loop range. Each is one user action, so each dispatches exactly one
 * command and logs exactly one analytics event, and only when the command
 * committed.
 *
 * The loop is song state: neither action touches the transport. The transport
 * follows because `useProjectAudio` mirrors `song.loop` onto it on every
 * project change, the same way it mirrors tempo. The ruler brace (#280) calls
 * `setLoopRangeFromDrag` with wherever the drag ended; the header's loop button
 * calls `toggleLooping`.
 */
export interface LoopActionContext {
  project(): Project | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  readonly analytics: Analytics;
}

/** Flip whether the transport obeys the song's loop range. */
export function toggleLooping(context: LoopActionContext): boolean {
  const project = context.project();
  if (!project) return false;
  const enabled = !project.song.loop.enabled;
  const result = context.dispatch(setLoopEnabled(enabled));
  if (!result?.ok) return false;
  context.analytics.log("loop_toggled", { enabled });
  return true;
}

/**
 * Commit a dragged loop range, snapped to whole bars. A drag that lands back
 * on the range the song already has is not a change: nothing is dispatched and
 * nothing is logged.
 */
export function setLoopRangeFromDrag(
  context: LoopActionContext,
  startTicks: number,
  endTicks: number,
): boolean {
  const project = context.project();
  if (!project) return false;
  const range = barAlignedLoop(startTicks, endTicks);
  const current = project.song.loop;
  if (range.startTicks === current.startTicks && range.endTicks === current.endTicks) {
    return false;
  }
  const result = context.dispatch(
    setLoopRange(toTicks(range.startTicks), toTicks(range.endTicks)),
  );
  if (!result?.ok) return false;
  context.analytics.log("loop_range_set", {
    bar_count: (range.endTicks - range.startTicks) / TICKS_PER_BAR,
  });
  return true;
}

/**
 * Move the brace by whole bars, keeping its length (the keyboard twin of
 * dragging its middle). The start stops at the top of the song, and a move
 * that would go nowhere is not a change: it commits and logs nothing.
 */
export function moveLoopByBars(context: LoopActionContext, bars: number): boolean {
  const loop = context.project()?.song.loop;
  if (!loop) return false;
  const start = Math.max(0, loop.startTicks + bars * TICKS_PER_BAR);
  return setLoopRangeFromDrag(context, start, start + loop.endTicks - loop.startTicks);
}

/**
 * Resize the brace by moving its end edge by whole bars, keeping its start.
 * It never gets shorter than one bar.
 */
export function resizeLoopByBars(context: LoopActionContext, bars: number): boolean {
  const loop = context.project()?.song.loop;
  if (!loop) return false;
  const end = Math.max(
    loop.startTicks + TICKS_PER_BAR,
    loop.endTicks + bars * TICKS_PER_BAR,
  );
  return setLoopRangeFromDrag(context, loop.startTicks, end);
}
