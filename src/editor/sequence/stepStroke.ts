import type { Analytics } from "../../analytics/analytics";
import type { Gesture, GestureOptions } from "../../commands";
import { addNotes, removeNotes } from "../../commands";
import type { NoteEvent } from "../../domain/entities";
import type { ClipId } from "../../domain/ids";
import { cellKey, eventCountBucket, type StepLane } from "./stepEditorModel";

/**
 * The CLP-02 step editor's paint/erase stroke machine.
 *
 * A stroke is one continuous pointer gesture across the grid. It is imperative
 * bookkeeping rather than rendered state, and it is deliberately *not* part of
 * `stepEditorModel.ts`: that module is a pure function of the clip and
 * instrument, whereas this one owns gesture lifetime, command dispatch, and
 * analytics. The component (`StepEditor.tsx`) still owns pointer events and
 * decides *when* a stroke begins, paints, and ends; everything that happens
 * *inside* one lives here so it can be unit-tested without a DOM.
 *
 * Every project mutation still goes through the shared command layer (PRD
 * section 9.6): each painted step applies immediately so audio stays live, but
 * the whole stroke commits as a single history entry and revision (CLP-02
 * "undo groups a single drag gesture").
 */

export type PaintMode = "add" | "erase";

export interface StrokeState {
  readonly gesture: Gesture;
  readonly mode: PaintMode;
  /** (lane, step) cells already visited this stroke, so a drag never re-fires. */
  readonly visited: Set<string>;
  /** How many cells this stroke actually changed, for `event_count_bucket`. */
  changed: number;
}

/**
 * Everything a stroke needs from its surroundings. Injected so the machine can
 * be driven in a test with a fake gesture kernel, a deterministic note-ID
 * factory, and a recording analytics client — no DOM and no Solid.
 */
export interface StrokeSeam {
  /** The clip being painted into. */
  readonly clipId: ClipId;
  /** Opens a paint/erase stroke that commits as one history entry. */
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The note already occupying a cell, if any — decides add vs erase. */
  noteAt(lane: StepLane, step: number): NoteEvent | undefined;
  /**
   * Mints the note a paint puts in a cell. Kept injectable so the note-ID
   * factory stays deterministic under test.
   */
  newNote(lane: StepLane, step: number): NoteEvent;
  /** The analytics client the completed stroke reports through. */
  analytics(): Analytics;
  /** A freshly painted note becomes the selection; an erased one leaves it. */
  onNoteAdded?(id: NoteEvent["id"]): void;
  onNoteRemoved?(id: NoteEvent["id"]): void;
}

export interface Stroke {
  /** The stroke currently in progress, or null. */
  readonly active: boolean;
  /** Opens a stroke on the cell the pointer went down on. */
  begin(lane: StepLane, step: number): void;
  /** Applies the stroke's mode to one cell, once. */
  paint(lane: StepLane, step: number): void;
  /** Commits the stroke as one entry, or cancels an empty one. */
  end(): void;
}

/** The history summary a committed stroke lands under. */
export function strokeSummary(mode: PaintMode, changed: number): string {
  const verb = mode === "add" ? "Paint" : "Erase";
  return `${verb} ${changed} step${changed === 1 ? "" : "s"}`;
}

/**
 * Builds the stroke machine over an injected seam. The returned object holds
 * the one in-flight `StrokeState`; `begin`/`paint`/`end` are the only ways to
 * move it.
 */
export function createStroke(seam: StrokeSeam): Stroke {
  let stroke: StrokeState | null = null;

  /** Applies the stroke's mode to one cell, once. Records what it changed. */
  function paint(lane: StepLane, step: number): void {
    if (!stroke) return;
    const key = cellKey(lane, step);
    if (stroke.visited.has(key)) return;
    stroke.visited.add(key);

    const existing = seam.noteAt(lane, step);
    if (stroke.mode === "add") {
      if (existing) return; // Already on; nothing to add.
      const note = seam.newNote(lane, step);
      stroke.gesture.apply(addNotes(seam.clipId, [note]));
      stroke.changed += 1;
      // A freshly painted note becomes the selection, so its velocity is
      // immediately editable.
      seam.onNoteAdded?.(note.id);
    } else {
      if (!existing) return; // Already off; nothing to erase.
      stroke.gesture.apply(removeNotes(seam.clipId, [existing.id]));
      stroke.changed += 1;
      seam.onNoteRemoved?.(existing.id);
    }
  }

  function begin(lane: StepLane, step: number): void {
    if (stroke) return;
    const gesture = seam.beginGesture();
    if (!gesture) return;
    // The cell the pointer went down on decides the whole stroke's mode:
    // starting on an occupied step erases, starting on an empty one paints.
    const existing = seam.noteAt(lane, step);
    const mode: PaintMode = existing ? "erase" : "add";
    stroke = { gesture, mode, visited: new Set(), changed: 0 };
    paint(lane, step);
  }

  function end(): void {
    if (!stroke) return;
    const active = stroke;
    stroke = null;
    if (active.changed === 0) {
      active.gesture.cancel();
      return;
    }
    active.gesture.commit(strokeSummary(active.mode, active.changed));

    // Analytics fires once per completed stroke, not per step (PRD OPS-02):
    // the `event_count_bucket` counts the steps this stroke changed.
    seam.analytics().log("clip_edited", {
      editor: "step",
      event_count_bucket: eventCountBucket(active.changed),
    });
    seam.analytics().logFeatureFirstUse("step_editor");
  }

  return {
    get active(): boolean {
      return stroke !== null;
    },
    begin,
    paint,
    end,
  };
}
