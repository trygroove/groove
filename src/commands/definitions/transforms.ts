import { z } from "zod";
import { nextClipLengthTicks } from "../../domain/clipLength";
import type { Clip, NoteEvent, Project } from "../../domain/entities";
import {
  type ClipId,
  clipIdSchema,
  type EventId,
  eventIdSchema,
  type IdFactory,
} from "../../domain/ids";
import { isChromatic, isPitchInKey, nearestPitchInKey } from "../../domain/musicalKey";
import { clampParameterValue, NOTE_VELOCITY } from "../../domain/parameters";
import { isTicks, type Ticks, toTicks } from "../../domain/time";
import { CONTROL_PARTS, controlAddress } from "../controlAddress";
import {
  clipLabel,
  findClip,
  noteEventsOf,
  pluralize,
  replaceClip,
  replacePlacement,
  selectEvents,
  withNoteEvents,
} from "../projectEdits";
import { describeGrid } from "../musicalWording";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RawCommandInput,
  type RegisteredCommand,
  rejected,
} from "../types";
import { updateClip } from "./clips";
import { addNotes, type NoteChanges, removeNotes, updateNotes } from "./notes";
import { placementsGrownWithClip, updatePlacement } from "./placements";

/**
 * Musical transformations (PRD CLP-04): transpose, velocity scaling,
 * quantize, duplicate, clear, and deterministic rhythmic variation.
 *
 * Each one is available to the pointer UI, the keyboard, and the assistant
 * through the same registered command, and each is a pure function of its
 * payload — including `notes.vary`, whose randomness comes from a seed in the
 * payload rather than from `Math.random`, so a proposal previews and applies
 * identically and redo reproduces it exactly.
 */

/** `null` selects every note in the clip; a list selects exactly those notes. */
const eventSelectionSchema = z.array(eventIdSchema).min(1).nullable();

export const notesTransposePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
  semitones: z.int().min(-127).max(127),
});
export type NotesTransposePayload = z.infer<typeof notesTransposePayloadSchema>;

export const notesQuantizeToScalePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
});
export type NotesQuantizeToScalePayload = z.infer<
  typeof notesQuantizeToScalePayloadSchema
>;

export const notesScaleVelocityPayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
  factor: z.number().positive().finite(),
});
export type NotesScaleVelocityPayload = z.infer<typeof notesScaleVelocityPayloadSchema>;

export const notesQuantizePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
  gridTicks: z.int().min(1),
  /** 0 leaves notes where they are; 1 snaps them fully onto the grid. */
  strength: z.number().min(0).max(1),
});
export type NotesQuantizePayload = z.infer<typeof notesQuantizePayloadSchema>;

export const notesDuplicatePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
  offsetTicks: z.int().min(1),
  /** One new event ID per duplicated note, minted by the caller. */
  newIds: z.array(eventIdSchema),
});
export type NotesDuplicatePayload = z.infer<typeof notesDuplicatePayloadSchema>;

export const notesClearPayloadSchema = z.strictObject({
  clipId: clipIdSchema,
});
export type NotesClearPayload = z.infer<typeof notesClearPayloadSchema>;

export const notesVaryPayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  eventIds: eventSelectionSchema,
  /** Same seed, same variation — this is what makes the command replayable. */
  seed: z.string().min(1),
  /** Share of notes the variation may touch, 0..1. */
  amount: z.number().min(0).max(1),
  gridTicks: z.int().min(1),
  /**
   * What varies (#653): timing, velocity, or both. Absent means both, which
   * is what `notes.vary` did before it had a target.
   */
  target: z.enum(["both", "timing", "velocity"]).optional(),
});
export type NotesVaryPayload = z.infer<typeof notesVaryPayloadSchema>;

interface Selection {
  clip: Clip;
  events: NoteEvent[];
}

/**
 * Resolves a payload's clip and selection, rejecting a clip that is missing,
 * holds audio rather than notes, has a stale selection, or selects nothing.
 * An empty selection is a rejection rather than a silent no-op so a
 * transformation never records a history entry that changed nothing.
 */
function resolveSelection(
  project: Project,
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
): Selection | { error: string } {
  const clip = findClip(project, clipId);
  if (!clip) {
    return { error: `Clip ${clipId} does not exist` };
  }
  if (!noteEventsOf(clip)) {
    return { error: `Clip ${clip.id} does not hold note content` };
  }
  const { selected, missing } = selectEvents(clip, eventIds ?? null);
  if (missing.length > 0) {
    return {
      error: `Clip ${clip.id} has no note ${missing.join(", ")} to transform`,
    };
  }
  if (selected.length === 0) {
    return { error: `Clip ${clip.id} has no notes to transform` };
  }
  return { clip, events: selected };
}

function isError(
  selection: Selection | { error: string },
): selection is { error: string } {
  return "error" in selection;
}

/** Writes changed events back into the clip, leaving untouched events identical. */
function withChangedEvents(
  project: Project,
  clip: Clip,
  changed: ReadonlyMap<string, NoteEvent>,
): Project {
  const events = noteEventsOf(clip) ?? [];
  return replaceClip(
    project,
    withNoteEvents(
      clip,
      events.map((event) => changed.get(event.id) ?? event),
    ),
  );
}

/** An inverse that restores exact previous values for the events it changed. */
function restoreCommand(
  project: Project,
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
  fields: (event: NoteEvent) => NoteChanges,
): RawCommandInput[] {
  const selection = resolveSelection(project, clipId, eventIds ?? null);
  if (isError(selection)) {
    return [];
  }
  const updates = selection.events.map((event) => ({
    eventId: event.id,
    changes: fields(event),
  }));
  return updates.length > 0 ? [updateNotes(clipId, updates)] : [];
}

export const notesTransposeCommand = defineCommand<NotesTransposePayload>({
  type: "notes.transpose",
  version: 1,
  schema: notesTransposePayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Transpose ${clipLabel(project, payload.clipId)} by ${signed(payload.semitones)} semitones`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    const changed = new Map<string, NoteEvent>();
    for (const event of selection.events) {
      if (event.trigger.kind !== "pitch") {
        continue;
      }
      const pitch = event.trigger.pitch + payload.semitones;
      if (pitch < 0 || pitch > 127) {
        return rejected(
          `Transposing note ${event.id} by ${payload.semitones} would leave the 0-127 pitch range`,
        );
      }
      changed.set(event.id, {
        ...event,
        trigger: { kind: "pitch", pitch },
      });
    }
    return applied(withChangedEvents(project, selection.clip, changed));
  },
  invert(payload, before) {
    const selection = resolveSelection(before, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return [];
    }
    // Transposition is exact (out-of-range input is rejected, never
    // clamped), so the inverse is the opposite transposition of the same
    // notes rather than a list of restored pitches.
    return [
      transposeNotes(
        payload.clipId,
        selection.events.map((event) => event.id),
        -payload.semitones,
      ),
    ];
  },
});

/**
 * Moves every note in scope that is outside the song's key onto the nearest
 * pitch in it, rounding a tie down (`nearestPitchInKey`, ARR-010). Notes
 * already in the key are left exactly as they were.
 *
 * The key is read from the song rather than carried in the payload, so the
 * command can never quantize to a key the project does not show. A chromatic
 * key has nothing to quantize to, and a scope with no stray note would record
 * an entry that changed nothing, so both are refusals rather than no-ops.
 */
export const notesQuantizeToScaleCommand = defineCommand<NotesQuantizeToScalePayload>({
  type: "notes.quantizeToScale",
  version: 1,
  schema: notesQuantizeToScalePayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Quantize ${clipLabel(project, payload.clipId)} to the key`,
  apply(project, payload) {
    const key = project.song.key;
    if (isChromatic(key)) {
      return rejected("The song key is chromatic, so there is no scale to quantize to");
    }
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    const changed = new Map<string, NoteEvent>();
    for (const event of selection.events) {
      if (event.trigger.kind !== "pitch" || isPitchInKey(key, event.trigger.pitch)) {
        continue;
      }
      const pitch = nearestPitchInKey(key, event.trigger.pitch);
      changed.set(event.id, { ...event, trigger: { kind: "pitch", pitch } });
    }
    if (changed.size === 0) {
      return rejected(`Every note in scope is already in the key`);
    }
    return applied(withChangedEvents(project, selection.clip, changed));
  },
  invert: (payload, before) =>
    restoreCommand(before, payload.clipId, payload.eventIds, (event) => ({
      trigger: event.trigger,
    })),
});

export const notesScaleVelocityCommand = defineCommand<NotesScaleVelocityPayload>({
  type: "notes.scaleVelocity",
  version: 1,
  schema: notesScaleVelocityPayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Scale velocity in ${clipLabel(project, payload.clipId)} by ${round(payload.factor)}x`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    const changed = new Map<string, NoteEvent>();
    for (const event of selection.events) {
      changed.set(event.id, {
        ...event,
        velocity: clampParameterValue(NOTE_VELOCITY, event.velocity * payload.factor),
      });
    }
    return applied(withChangedEvents(project, selection.clip, changed));
  },
  // Scaling clamps at the ends of the velocity range, so the inverse
  // restores the recorded values instead of dividing by the factor.
  invert: (payload, before) =>
    restoreCommand(before, payload.clipId, payload.eventIds, (event) => ({
      velocity: event.velocity,
    })),
});

export const notesQuantizeCommand = defineCommand<NotesQuantizePayload>({
  type: "notes.quantize",
  version: 1,
  schema: notesQuantizePayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Quantize ${clipLabel(project, payload.clipId)} to ${describeGrid(payload.gridTicks)}`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    const changed = new Map<string, NoteEvent>();
    for (const event of selection.events) {
      const startTicks = quantizedStart(
        event.startTicks,
        payload.gridTicks,
        payload.strength,
        selection.clip.lengthTicks,
      );
      changed.set(event.id, { ...event, startTicks });
    }
    return applied(withChangedEvents(project, selection.clip, changed));
  },
  invert: (payload, before) =>
    restoreCommand(before, payload.clipId, payload.eventIds, (event) => ({
      startTicks: event.startTicks,
    })),
});

/**
 * Snaps toward the nearest grid line, never past the end of the clip: a note
 * whose nearest line is the clip boundary snaps back to the previous line
 * instead of moving outside its clip.
 */
function quantizedStart(
  startTicks: number,
  gridTicks: number,
  strength: number,
  lengthTicks: number,
): Ticks {
  let target = Math.round(startTicks / gridTicks) * gridTicks;
  while (target >= lengthTicks && target - gridTicks >= 0) {
    target -= gridTicks;
  }
  if (target >= lengthTicks) {
    target = lengthTicks - 1;
  }
  return toTicks(Math.round(startTicks + (target - startTicks) * strength));
}

export const notesDuplicateCommand = defineCommand<NotesDuplicatePayload>({
  type: "notes.duplicate",
  version: 1,
  schema: notesDuplicatePayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Duplicate ${pluralize(payload.newIds.length, "note")} in ${clipLabel(project, payload.clipId)}`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    if (payload.newIds.length !== selection.events.length) {
      return rejected(
        `Duplicating ${selection.events.length} notes needs ${selection.events.length} new ids, received ${payload.newIds.length}`,
      );
    }
    const existing = new Set(
      (noteEventsOf(selection.clip) ?? []).map((event) => event.id),
    );
    const copies: NoteEvent[] = [];
    let neededTicks = 0;
    for (const [index, event] of selection.events.entries()) {
      const id = payload.newIds[index];
      if (existing.has(id)) {
        continue;
      }
      // The offset is only bounded below by the schema, so the copy's
      // position is range-checked before it becomes a tick: an offset that
      // leaves the safe-integer range is a rejection with a reason, not a
      // throw out of `toTicks`.
      const startTicks = event.startTicks + payload.offsetTicks;
      if (!isTicks(startTicks)) {
        return rejected(pastTheEnd(payload.offsetTicks, selection.clip));
      }
      neededTicks = Math.max(neededTicks, startTicks + event.durationTicks);
      copies.push({ ...event, id, startTicks });
    }
    if (copies.length !== payload.newIds.length) {
      return rejected("Duplicate note ids must be new");
    }
    // Issue #256: asking to duplicate is an unambiguous intent, so a copy with
    // no room grows the clip instead of rejecting the edit. The resize happens
    // inside this one command, which is what makes it one revision and one
    // undo step with the copies rather than a second transaction.
    const lengthTicks = extendedLength(selection.clip, neededTicks);
    if (lengthTicks === null) {
      return rejected(pastTheEnd(payload.offsetTicks, selection.clip));
    }
    const withCopies = withNoteEvents(selection.clip, [
      ...(noteEventsOf(selection.clip) ?? []),
      ...copies,
    ]);
    // #963: the clip's placements that showed its whole length grow with it
    // in the same command, or the copies would never play or export.
    const grown = placementsGrownWithClip(
      project,
      selection.clip.id,
      selection.clip.lengthTicks,
      lengthTicks,
    );
    return applied(
      grown.reduce(
        replacePlacement,
        replaceClip(project, { ...withCopies, lengthTicks }),
      ),
    );
  },
  invert(payload, before, after) {
    const commands: RawCommandInput[] = [];
    if (payload.newIds.length > 0) {
      commands.push(removeNotes(payload.clipId, payload.newIds));
    }
    // The notes come out before the clip shrinks back, or the restored project
    // would briefly hold notes outside their clip.
    const previous = findClip(before, payload.clipId);
    const next = findClip(after, payload.clipId);
    if (previous && next && previous.lengthTicks !== next.lengthTicks) {
      commands.push(updateClip(payload.clipId, { lengthTicks: previous.lengthTicks }));
    }
    for (const placement of before.song.placements) {
      const grown = after.song.placements.find((other) => other.id === placement.id);
      if (grown && grown.durationTicks !== placement.durationTicks) {
        commands.push(
          updatePlacement(placement.id, { durationTicks: placement.durationTicks }),
        );
      }
    }
    return commands;
  },
});

function pastTheEnd(offsetTicks: number, clip: Clip): string {
  return `Duplicating by ${offsetTicks} ticks would push a note past the end of clip ${clip.id}`;
}

/**
 * The length the clip needs to hold copies ending at `neededTicks`: its own
 * length when they already fit, the next listed clip length when they do not,
 * and `null` when even the longest clip could not hold them.
 */
function extendedLength(clip: Clip, neededTicks: number): Ticks | null {
  return neededTicks > clip.lengthTicks
    ? nextClipLengthTicks(neededTicks)
    : clip.lengthTicks;
}

export const notesClearCommand = defineCommand<NotesClearPayload>({
  type: "notes.clear",
  version: 1,
  schema: notesClearPayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Clear notes from ${clipLabel(project, payload.clipId)}`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, null);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    return applied(replaceClip(project, withNoteEvents(selection.clip, [])));
  },
  invert(payload, before) {
    const clip = findClip(before, payload.clipId);
    const events = clip ? (noteEventsOf(clip) ?? []) : [];
    return events.length > 0 ? [addNotes(payload.clipId, events)] : [];
  },
});

export const notesVaryCommand = defineCommand<NotesVaryPayload>({
  type: "notes.vary",
  version: 1,
  schema: notesVaryPayloadSchema,
  touches: (payload) => [controlAddress(payload.clipId, CONTROL_PARTS.notes)],
  summarize: (payload, project) =>
    `Vary ${clipLabel(project, payload.clipId)} (seed ${payload.seed})`,
  apply(project, payload) {
    const selection = resolveSelection(project, payload.clipId, payload.eventIds);
    if (isError(selection)) {
      return rejected(selection.error);
    }
    const random = seededRandom(payload.seed);
    const changed = new Map<string, NoteEvent>();
    for (const event of selection.events) {
      // Three draws per note regardless of the outcome, so one note's
      // result never depends on whether an earlier note was varied.
      const roll = random();
      const direction = random() < 0.5 ? -1 : 1;
      const accent = random();
      if (roll >= payload.amount) {
        continue;
      }
      const target = payload.target ?? "both";
      const startTicks =
        target === "velocity"
          ? event.startTicks
          : shiftedStart(
              event.startTicks,
              direction * payload.gridTicks,
              selection.clip.lengthTicks,
            );
      // Both: x0.7-1.3, as before targets. Velocity alone: within 20% (#653).
      const spread = target === "velocity" ? 0.2 : 0.3;
      const velocity =
        target === "timing"
          ? event.velocity
          : clampParameterValue(
              NOTE_VELOCITY,
              event.velocity * (1 - spread + accent * spread * 2),
            );
      if (startTicks === event.startTicks && velocity === event.velocity) {
        continue;
      }
      changed.set(event.id, { ...event, startTicks, velocity });
    }
    return applied(withChangedEvents(project, selection.clip, changed));
  },
  invert: (payload, before) =>
    restoreCommand(before, payload.clipId, payload.eventIds, (event) => ({
      startTicks: event.startTicks,
      velocity: event.velocity,
    })),
});

/** Shifts a note, reflecting off either end of the clip rather than leaving it. */
function shiftedStart(startTicks: number, delta: number, lengthTicks: number): Ticks {
  const forward = startTicks + delta;
  if (forward >= 0 && forward < lengthTicks) {
    return toTicks(forward);
  }
  const back = startTicks - delta;
  if (back >= 0 && back < lengthTicks) {
    return toTicks(back);
  }
  return toTicks(startTicks);
}

/**
 * Mulberry32 seeded from the payload's seed string. Deterministic across
 * engines and processes, which is what makes `notes.vary` replayable.
 */
function seededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 0x9e3779b9 : hash;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function round(value: number): string {
  return `${Number(value.toFixed(3))}`;
}

// --- Typed builders -------------------------------------------------------

export function transposeNotes(
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
  semitones: number,
): CommandInput<NotesTransposePayload> {
  return {
    type: notesTransposeCommand.type,
    payload: { clipId, eventIds: selectionOf(eventIds), semitones },
  };
}

export function scaleNoteVelocity(
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
  factor: number,
): CommandInput<NotesScaleVelocityPayload> {
  return {
    type: notesScaleVelocityCommand.type,
    payload: { clipId, eventIds: selectionOf(eventIds), factor },
  };
}

export function quantizeNotes(
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
  gridTicks: number,
  strength = 1,
): CommandInput<NotesQuantizePayload> {
  return {
    type: notesQuantizeCommand.type,
    payload: { clipId, eventIds: selectionOf(eventIds), gridTicks, strength },
  };
}

export function quantizeNotesToScale(
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
): CommandInput<NotesQuantizeToScalePayload> {
  return {
    type: notesQuantizeToScaleCommand.type,
    payload: { clipId, eventIds: selectionOf(eventIds) },
  };
}

export function clearNotes(clipId: ClipId): CommandInput<NotesClearPayload> {
  return { type: notesClearCommand.type, payload: { clipId } };
}

export function varyNotes(
  clipId: ClipId,
  eventIds: readonly EventId[] | null,
  options: {
    seed: string;
    amount: number;
    gridTicks: number;
    target?: NotesVaryPayload["target"];
  },
): CommandInput<NotesVaryPayload> {
  return {
    type: notesVaryCommand.type,
    payload: { clipId, eventIds: selectionOf(eventIds), ...options },
  };
}

/**
 * Builds a duplicate command, minting one event ID per selected note. The IDs
 * live in the payload, so undo/redo and an assistant preview all reproduce the
 * same events.
 */
export function duplicateNotes(
  ids: IdFactory,
  project: Project,
  options: {
    clipId: ClipId;
    eventIds?: readonly EventId[] | null;
    offsetTicks: number;
  },
): CommandInput<NotesDuplicatePayload> {
  const eventIds = options.eventIds ?? null;
  const selection = resolveSelection(project, options.clipId, eventIds);
  const count = isError(selection) ? 0 : selection.events.length;
  return {
    type: notesDuplicateCommand.type,
    payload: {
      clipId: options.clipId,
      eventIds: selectionOf(eventIds),
      offsetTicks: options.offsetTicks,
      newIds: Array.from({ length: count }, () => ids("event")),
    },
  };
}

function selectionOf(eventIds: readonly EventId[] | null): EventId[] | null {
  return eventIds === null ? null : [...eventIds];
}

/** Registered, payload-erased commands from this module. */
export const transformCommands: readonly RegisteredCommand[] = [
  eraseCommand(notesTransposeCommand),
  eraseCommand(notesScaleVelocityCommand),
  eraseCommand(notesQuantizeCommand),
  eraseCommand(notesDuplicateCommand),
  eraseCommand(notesClearCommand),
  eraseCommand(notesVaryCommand),
  eraseCommand(notesQuantizeToScaleCommand),
];
