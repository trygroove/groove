import type { RawCommandInput } from "../../commands";
import { addNotes, removeNotes } from "../../commands";
import type { Clip, NoteEvent, NoteTrigger } from "../../domain/entities";
import type { EventId, IdFactory } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import {
  noteEventsOf,
  stepCount,
  stepStartTicks,
  triggersMatch,
} from "./stepEditorModel";
import type { Hit } from "./stepGenerators";

/**
 * Writing a generator's hits into one row of the step grid (#643).
 *
 * A generate replaces the row: `rowCommands` builds the existing `note.remove`
 * and `note.add` commands, so it is one ordinary transaction (one undo entry,
 * one revision) rather than a new registered command, and the other rows are
 * never touched. `previewRow` says what it would change, without changing it,
 * for the grid's hover preview.
 */

/** The clip's notes in one row: every note whose trigger is the row's. */
export function rowNotes(clip: Clip, trigger: NoteTrigger): NoteEvent[] {
  return noteEventsOf(clip).filter((note) => triggersMatch(note.trigger, trigger));
}

/** Hits past the end of the clip are dropped. */
function inClip(clip: Clip, hits: readonly Hit[]): Hit[] {
  const steps = stepCount(clip);
  return hits.filter((hit) => hit.step >= 0 && hit.step < steps);
}

/** True when the row already holds exactly these notes (ids aside). */
function sameNotes(row: readonly NoteEvent[], notes: readonly NoteEvent[]): boolean {
  if (row.length !== notes.length) return false;
  const key = (note: NoteEvent) =>
    `${note.startTicks}:${note.durationTicks}:${note.velocity}:${note.probability}`;
  const held = new Map<string, number>();
  for (const note of row) held.set(key(note), (held.get(key(note)) ?? 0) + 1);
  for (const note of notes) {
    const left = held.get(key(note)) ?? 0;
    if (left === 0) return false;
    held.set(key(note), left - 1);
  }
  return true;
}

/**
 * The commands that replace a row with `hits`: remove every note in the row,
 * then add one 16th per hit. Other rows are untouched. Empty when the row already
 * matches (or is empty and stays empty), so a no-op writes no revision.
 */
export function rowCommands(
  clip: Clip,
  trigger: NoteTrigger,
  hits: readonly Hit[],
  ids: IdFactory,
): RawCommandInput[] {
  const row = rowNotes(clip, trigger);
  const existing = row.map((note) => note.id);
  const notes: NoteEvent[] = inClip(clip, hits).map((hit) => ({
    id: ids("event"),
    trigger,
    startTicks: stepStartTicks(hit.step) as NoteEvent["startTicks"],
    durationTicks: TICKS_PER_SIXTEENTH as NoteEvent["durationTicks"],
    velocity: hit.velocity as NoteEvent["velocity"],
    probability: null,
  }));
  if (sameNotes(row, notes)) return [];
  const commands: RawCommandInput[] = [];
  if (existing.length > 0) commands.push(removeNotes(clip.id, existing));
  if (notes.length > 0) commands.push(addNotes(clip.id, notes));
  return commands;
}

/** What a generator would change in a row, before it changes anything. */
export interface RowPreview {
  /** Steps it would turn on that are off now. */
  readonly added: ReadonlySet<number>;
  /** Notes it would take away: those not on one of its steps. */
  readonly removed: ReadonlySet<EventId>;
}

export function previewRow(
  clip: Clip,
  trigger: NoteTrigger,
  hits: readonly Hit[],
): RowPreview {
  const kept = new Set(inClip(clip, hits).map((hit) => stepStartTicks(hit.step)));
  const row = rowNotes(clip, trigger);
  const on = new Set<number>(row.map((note) => note.startTicks));
  return {
    added: new Set(
      inClip(clip, hits)
        .filter((hit) => !on.has(stepStartTicks(hit.step)))
        .map((hit) => hit.step),
    ),
    removed: new Set(
      row.filter((note) => !kept.has(note.startTicks)).map((note) => note.id),
    ),
  };
}
