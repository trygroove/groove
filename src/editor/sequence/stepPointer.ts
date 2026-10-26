import { createSignal } from "solid-js";
import type { NoteEvent } from "../../domain/entities";
import type { EventId } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { pointerModifierHeld, type ShortcutPlatform } from "../../shortcuts";
import { isDrag, ROW_HEIGHT, rectFrom, touches } from "../pianoRoll/layout";
import { type StepLane, triggersMatch } from "./stepEditorModel";

type Rect = ReturnType<typeof rectFrom>;

/**
 * The notes a lasso touches: each note is the cell its lane crosses its step,
 * one step wide and one row tall, in the lanes' own pixels.
 */
export function lassoHits(
  notes: readonly NoteEvent[],
  lanes: readonly StepLane[],
  rect: Rect,
  stepWidth: number,
): EventId[] {
  return notes
    .filter((note) => {
      const row = lanes.findIndex((lane) => triggersMatch(note.trigger, lane.trigger));
      if (row < 0) return false;
      const step = Math.floor(note.startTicks / TICKS_PER_SIXTEENTH);
      const box = {
        left: step * stepWidth,
        top: row * ROW_HEIGHT,
        width: stepWidth,
        height: ROW_HEIGHT,
      };
      return touches(box, rect);
    })
    .map((note) => note.id);
}

export interface StepPointerHost {
  /** The lanes' container: lasso coordinates are measured from its corner. */
  lanes(): HTMLElement | undefined;
  laneList(): readonly StepLane[];
  notes(): readonly NoteEvent[];
  stepWidth(): number;
  selected(): readonly EventId[];
  setSelected(ids: readonly EventId[]): void;
  /** A press that did not travel: toggles the step, as a click always has. */
  click(lane: StepLane, step: number, add: boolean): void;
  readonly platform: ShortcutPlatform;
}

interface Press {
  /** The cell pressed, or null for the empty ground under the last row. */
  readonly cell: { readonly lane: StepLane; readonly step: number } | null;
  readonly x: number;
  readonly y: number;
  readonly add: boolean;
  readonly base: readonly EventId[];
  started: boolean;
}

/**
 * The step grid's pointer (#643), the piano roll's rule: a press that moves
 * under 4 px is a click, which toggles the step; one that moves further is a
 * lasso, which selects every note it touches. Shift or Cmd/Ctrl adds to the
 * selection, through the roll's own pointer modifiers. A lasso only selects,
 * so it never touches the project or the history. A press on the empty ground
 * under the last row starts a lasso too; clicked, it clears the selection.
 *
 * The press is a plain variable, not a signal, so a pointerup sees what its
 * pointerdown just set.
 */
export function useStepPointer(host: StepPointerHost) {
  const [lasso, setLasso] = createSignal<Rect | null>(null);
  let press: Press | null = null;

  function point(event: PointerEvent): { x: number; y: number } {
    const box = host.lanes()?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  function adds(event: MouseEvent): boolean {
    return (
      pointerModifierHeld("piano_roll.toggle_select", event, host.platform) ||
      pointerModifierHeld("piano_roll.shift_select", event, host.platform)
    );
  }

  function down(event: PointerEvent, lane?: StepLane, step?: number): void {
    if ((event.button ?? 0) > 0) return;
    // Keeps a drag from starting a text selection (CLP-02).
    event.preventDefault();
    const { x, y } = point(event);
    const cell = lane && step !== undefined ? { lane, step } : null;
    press = { cell, x, y, add: adds(event), base: host.selected(), started: false };
  }

  /** Enter or Space on a focused step: the click a press would have made. */
  function key(lane: StepLane, step: number, event: MouseEvent): void {
    host.click(lane, step, adds(event));
  }

  function move(event: PointerEvent): void {
    const current = press;
    if (!current) return;
    const { x, y } = point(event);
    if (!current.started) {
      if (!isDrag(x - current.x, y - current.y)) return;
      current.started = true;
      host.lanes()?.setPointerCapture?.(event.pointerId);
    }
    const rect = rectFrom(current.x, current.y, x, y);
    setLasso(rect);
    const hits = lassoHits(host.notes(), host.laneList(), rect, host.stepWidth());
    host.setSelected(current.add ? [...new Set([...current.base, ...hits])] : hits);
  }

  function up(): void {
    const current = press;
    press = null;
    setLasso(null);
    if (!current || current.started) return;
    if (current.cell) host.click(current.cell.lane, current.cell.step, current.add);
    else if (!current.add) host.setSelected([]);
  }

  function cancel(): void {
    press = null;
    setLasso(null);
  }

  /** A click that wanders off the grid is no click; a lasso keeps its capture. */
  function leave(): void {
    if (press && !press.started) cancel();
  }

  return { down, key, move, up, cancel, leave, lasso };
}
