import type { NoteEditOperation } from "../../analytics/catalog";
import type { CommandInput, RawCommandInput } from "../../commands";
import {
  clearNotes,
  noteEventsOf,
  quantizeNotes,
  quantizeNotesToScale,
  transposeNotes,
  varyNotes,
} from "../../commands";
import type { Clip, Project } from "../../domain/entities";
import type { EventId, IdFactory } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { doubleClip } from "./doubleClip";
import { halveClip } from "./halveClip";

/**
 * Pure, framework-free model behind the CLP-04 transformation panel.
 *
 * `TransformPanel.tsx` owns the buttons, the dispatch, and the analytics; every
 * decision that is a *function of the clip and the current selection* lives
 * here, so scope resolution, seeding, and the enabled/disabled rules are unit
 * testable without a DOM.
 *
 * Nothing here mutates a project. Each builder returns a `CommandInput` for one
 * of the six already-registered `notes.*` transformations, so the panel adds no
 * mutation path of its own — the same commands the assistant will call.
 */

/** The transformations the panel exposes, in the order it renders them. */
export const TRANSFORM_KINDS = [
  "transpose",
  "vary",
  "varyVelocity",
  "quantize",
  "quantizeToScale",
  "halve",
  "duplicate",
  "clear",
] as const;
export type TransformKind = (typeof TRANSFORM_KINDS)[number];

/** Quantize and vary both work against the editors' 16th-note grid. */
export const TRANSFORM_GRID_TICKS = TICKS_PER_SIXTEENTH;

/**
 * The selection a transformation applies to.
 *
 * `null` event IDs mean "every note in the clip" — the command layer's own
 * convention (`eventSelectionSchema`), not a separate notion of scope. So an
 * empty pointer selection widens to the whole clip rather than doing nothing,
 * which is what makes the panel useful before the user has selected anything.
 */
export interface TransformScope {
  /** `null` selects the whole clip. */
  readonly eventIds: readonly EventId[] | null;
  /** How many notes the transformation will actually touch. */
  readonly count: number;
  /** True when the scope widened to the clip because nothing was selected. */
  readonly isWholeClip: boolean;
  /** The row an empty selection fell back to, when the editor has one (#643). */
  readonly rowName?: string;
}

/**
 * What an empty selection means instead of the whole clip. The step grid
 * passes its active row (#643), so with nothing selected a Vary touches only
 * the row you are looking at, never every drum at once.
 */
export interface TransformFallback {
  readonly name: string;
  readonly eventIds: readonly EventId[];
}

/**
 * Resolves the scope for a clip and the editor's current selection.
 *
 * Selected IDs that are no longer in the clip are dropped rather than passed
 * through: a stale ID makes the command reject the whole transformation, and a
 * selection can outlive the notes it points at (an undo, or a remote edit).
 */
export function resolveTransformScope(
  clip: Clip,
  selectedIds: readonly EventId[],
  fallback?: TransformFallback | null,
): TransformScope {
  const events = noteEventsOf(clip) ?? [];
  const present = new Set(events.map((event) => event.id));
  const live = selectedIds.filter((id) => present.has(id));
  if (live.length === 0 && fallback) {
    const row = fallback.eventIds.filter((id) => present.has(id));
    return {
      eventIds: row,
      count: row.length,
      isWholeClip: false,
      rowName: fallback.name,
    };
  }
  if (live.length === 0) {
    return { eventIds: null, count: events.length, isWholeClip: true };
  }
  return { eventIds: live, count: live.length, isWholeClip: false };
}

/**
 * Whether a transformation can run at all.
 *
 * Every one of the six commands rejects a clip with no notes in scope, so the
 * panel disables its buttons rather than dispatching a transaction that is
 * certain to fail and would surface as an error the user did not cause.
 */
export function canTransform(scope: TransformScope): boolean {
  return scope.count > 0;
}

export interface TransformOptions {
  /** Semitones for `transpose`. */
  readonly semitones: number;
  /** Share of notes Vary timing may move, 0..1. */
  readonly amount: number;
}

export const DEFAULT_TRANSFORM_OPTIONS: TransformOptions = {
  semitones: 12,
  amount: 0.5,
};

/**
 * Builds the command for one transformation, or for Double the commands of
 * one transaction (`doubleClip.ts`).
 *
 * `duplicate` needs an ID factory and the project because its copies carry
 * their new event IDs explicitly — that is what makes redo and an assistant
 * preview reproduce the same notes rather than minting fresh ones each time.
 */
export function buildTransform(
  kind: TransformKind,
  context: {
    readonly project: Project;
    readonly clip: Clip;
    readonly scope: TransformScope;
    readonly ids: IdFactory;
    readonly options: TransformOptions;
  },
): CommandInput<never> | RawCommandInput | readonly RawCommandInput[] {
  const { clip, scope, options } = context;
  switch (kind) {
    case "transpose":
      return transposeNotes(clip.id, scope.eventIds, options.semitones);
    case "quantize":
      return quantizeNotes(clip.id, scope.eventIds, TRANSFORM_GRID_TICKS, 1);
    case "quantizeToScale":
      // The key is the song's; the command reads it, so it is not passed.
      return quantizeNotesToScale(clip.id, scope.eventIds);
    case "duplicate":
      // Double copies the whole clip, whatever is selected (#647).
      return doubleClip(context.project, clip, context.ids);
    case "halve":
      // Halve keeps the whole clip's first half, whatever is selected (#662).
      return halveClip(context.project, clip);
    case "clear":
      // `notes.clear` empties the whole clip by definition — it takes no
      // selection — so the panel labels it for the clip, never the selection.
      return clearNotes(clip.id);
    // Both Varies are random on every press (#653): the seed is minted here,
    // never shown, and carried in the payload so undo and redo replay it.
    case "vary":
      return varyNotes(clip.id, scope.eventIds, {
        seed: context.ids("event"),
        amount: options.amount,
        gridTicks: TRANSFORM_GRID_TICKS,
        target: "timing",
      });
    case "varyVelocity":
      return varyNotes(clip.id, scope.eventIds, {
        seed: context.ids("event"),
        amount: 1,
        gridTicks: TRANSFORM_GRID_TICKS,
        target: "velocity",
      });
  }
}

/** How many notes a transformation reports to `clip_edited`'s count bucket. */
export function transformedEventCount(
  kind: TransformKind,
  scope: TransformScope,
  clip: Clip,
): number {
  if (kind === "clear" || kind === "duplicate" || kind === "halve") {
    // Clear and Double act on the whole clip, whatever happened to be selected.
    return (noteEventsOf(clip) ?? []).length;
  }
  return scope.count;
}

/** The button label for each transformation. `duplicate` reads as Double. */
export const TRANSFORM_LABELS: Readonly<Record<TransformKind, string>> = {
  transpose: "Transpose",
  quantize: "Quantize",
  quantizeToScale: "Quantize to scale",
  duplicate: "Double",
  halve: "Halve",
  clear: "Clear clip",
  vary: "Vary timing",
  varyVelocity: "Vary velocity",
};

/** How a refused transformation is named in `note_edit_failed`. */
export const TRANSFORM_OPERATIONS: Readonly<Record<TransformKind, NoteEditOperation>> = {
  transpose: "transpose",
  quantize: "quantize",
  quantizeToScale: "quantize_to_scale",
  duplicate: "double",
  halve: "halve",
  clear: "clear",
  vary: "vary",
  varyVelocity: "vary_velocity",
};

/** "+12 st", "−5 st": a semitone count as its field shows it. */
export function formatSemitones(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)} st`;
}

/** A typed semitone count, within the command's range, or null. */
export function parseSemitones(text: string): number | null {
  const match = /^\s*([+\-−]?)\s*(\d+)/.exec(text);
  if (!match) return null;
  const magnitude = Number(match[2]);
  const value = match[1] === "-" || match[1] === "−" ? -magnitude : magnitude;
  return Math.max(-127, Math.min(127, value));
}

/** One semitone up or down, kept within the command's range. */
export function nudgeSemitones(value: number, direction: 1 | -1): number {
  return Math.max(-127, Math.min(127, value + direction));
}
