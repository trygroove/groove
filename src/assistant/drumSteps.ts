/**
 * Drum parts as step strings (GRV-140), behind the `drumStepStrings` tactic.
 *
 * A drum part is usually a grid, and even as GRV-131's compact tuples it costs
 * one array per hit. With the tactic on, `clip_create` on a drum machine also
 * takes one string per pad:
 *
 * ```
 * { padId, steps: "x.o.X.o.x.o.X.oo", stepTicks: 48, velocity: { x: 100, X: 120, o: 50 } }
 * ```
 *
 * - **Grid:** each string has its own `stepTicks` (default 48, a 16th at 192
 *   PPQ), so 8ths, 32nds and triplets (32 for 16th triplets) all work.
 * - **Dynamics:** `x` is a hit, `X` an accent, `o` a ghost and `.` a rest.
 *   The three velocities are MIDI-style (1 to 127, defaults 100 / 120 / 50),
 *   set once per string; a note event's velocity is the value over 127.
 * - **Length:** the string repeats from the clip's start until the clip ends;
 *   a string longer than the clip is refused. A hit lasts one step, cut short
 *   at the clip's end.
 *
 * The gateway writes each string out as ordinary note events, numbered by the
 * turn's note expander (`compactNotes.ts`) in the same counter as tuples, so
 * nothing past the gateway ever sees a step string.
 *
 * Pure, and like the rest of `src/assistant`, free of Firebase and any SDK.
 */
import { z } from "zod";
import {
  clipLengthTickSchema,
  MAX_CLIP_LENGTH_BARS,
  MAX_CLIP_LENGTH_TICKS,
} from "../domain/clipLength";
import type { NoteEvent } from "../domain/entities";
import { padIdSchema } from "../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../domain/time";

/** The step a string takes when it names none: a 16th. */
export const DEFAULT_STEP_TICKS = TICKS_PER_SIXTEENTH;

/** The three hit characters, and the MIDI-style velocity each takes by default. */
export const DEFAULT_STEP_VELOCITIES = { x: 100, X: 120, o: 50 } as const;
export type StepHit = keyof typeof DEFAULT_STEP_VELOCITIES;

/** A rest. */
export const STEP_REST = ".";

/** The highest MIDI-style velocity, which a note event's velocity of 1 stands for. */
const MAX_STEP_VELOCITY = 127;

const STEP_PATTERN = /^[xXo.]+$/;

const stepVelocitySchema = z.int().min(1).max(MAX_STEP_VELOCITY);

/**
 * What a step string's velocities are, said the same way wherever the model
 * reads about them: a MIDI scale, so it is not mistaken for a note array's 0 to 1.
 */
export const STEP_VELOCITY_SCALE = `velocity sets x, X and o once, on a MIDI scale of 1 to ${MAX_STEP_VELOCITY}, not the 0 to 1 of a note array (default ${DEFAULT_STEP_VELOCITIES.x}, ${DEFAULT_STEP_VELOCITIES.X}, ${DEFAULT_STEP_VELOCITIES.o}; Groove writes each as the value over ${MAX_STEP_VELOCITY})`;

/** What the tools say a step string is. */
export const DRUM_STEPS_DESCRIPTION = `A drum pad's part as a step string: one character per step, x a hit, X an accent, o a ghost, . a rest. stepTicks is the step's length (default ${DEFAULT_STEP_TICKS}, a 16th; 96 an 8th, 24 a 32nd, 32 a 16th triplet). ${STEP_VELOCITY_SCALE}. The string repeats from the clip's start to its end, so write one bar for a clip of any length; it may not be longer than the clip. No IDs: Groove gives each hit its own.`;

/** One step string as the model writes it. */
export const drumStepsSchema = z
  .strictObject({
    padId: padIdSchema,
    steps: z
      .string()
      .min(1)
      .regex(STEP_PATTERN, "only x (hit), X (accent), o (ghost) and . (rest)"),
    stepTicks: z.int().positive().optional(),
    velocity: z
      .strictObject({
        x: stepVelocitySchema.optional(),
        X: stepVelocitySchema.optional(),
        o: stepVelocitySchema.optional(),
      })
      .optional(),
  })
  .describe(DRUM_STEPS_DESCRIPTION);
export type DrumSteps = z.infer<typeof drumStepsSchema>;

/** Whether `value` is meant as a step string: an object with a `steps` field. */
export function isStepEntry(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "steps")
  );
}

/** One hit a step string makes, before it has an ID. */
export interface StepHitEvent {
  readonly padId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly velocity: number;
}

/** A step string's hits, or why it makes none. */
export type StepExpansion =
  | { readonly ok: true; readonly hits: readonly StepHitEvent[] }
  | {
      readonly ok: false;
      /** The entry's field at fault, or null for the entry as a whole. */
      readonly field: string | null;
      readonly reason: string;
    };

/** What a step string is checked against: its clip's length and its track's pads. */
export interface StepClip {
  /** The clip's length, refused unless it is a clip length (`clipLengthTickSchema`). */
  readonly lengthTicks: number;
  /** The track's pads, or undefined when the track is not known. */
  readonly pads: ReadonlySet<string> | undefined;
  readonly trackId: string;
  /** The most hits the string may make: what is left of the turn's notes, as the caller counts them. */
  readonly maxHits: number;
}

/** A velocity of 1 to 127 as a note event's, rounded to three places. */
function noteVelocity(value: number): number {
  return Math.round((value / MAX_STEP_VELOCITY) * 1000) / 1000;
}

/**
 * The hits `raw` makes in `clip`, in tick order, or why it is refused: a
 * malformed entry, an unknown character, a `stepTicks` that is not a positive
 * integer, a clip longer than a clip may be, a string longer than the clip,
 * or a pad the track does not have. The same input always makes the same hits.
 *
 * The clip's length is checked before anything is expanded, and the walk
 * visits only hit positions, so neither a huge clip nor a string of rests can
 * keep it busy: the work is bounded by the clip's maximum length.
 */
export function expandDrumSteps(raw: unknown, clip: StepClip): StepExpansion {
  const parsed = drumStepsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || null;
    if (field === "steps" && isStepEntry(raw) && typeof raw.steps === "string") {
      const bad = [...raw.steps].findIndex((char) => !"xXo.".includes(char));
      if (bad >= 0) {
        return refused(
          "steps",
          `"${[...raw.steps][bad]}" at step ${bad + 1} is not a step; use only x (hit), X (accent), o (ghost) and . (rest)`,
        );
      }
    }
    if (field === "stepTicks") {
      return refused("stepTicks", "must be a positive whole number of ticks, e.g. 48");
    }
    return refused(
      field,
      `${issue?.message ?? "not a step string"}; a step string is { padId, steps, stepTicks?, velocity? }`,
    );
  }
  const entry = parsed.data;
  const pads = clip.pads;
  if (pads === undefined || pads.size === 0) {
    return refused(
      "padId",
      `the track "${clip.trackId.slice(0, 64)}" is not a drum machine in the project or created earlier in this reply; step strings are for drum pads`,
    );
  }
  if (!pads.has(entry.padId)) {
    return refused(
      "padId",
      `the track "${clip.trackId.slice(0, 64)}" has no pad "${entry.padId.slice(0, 64)}". Use one of its pads: ${[...pads].join(", ")}`,
    );
  }
  if (!clipLengthTickSchema.safeParse(clip.lengthTicks).success) {
    return refused(
      null,
      `the clip's lengthTicks must be a whole number from 1 to ${MAX_CLIP_LENGTH_TICKS} (${MAX_CLIP_LENGTH_BARS} bars) for its step strings to fill`,
    );
  }
  const stepTicks = entry.stepTicks ?? DEFAULT_STEP_TICKS;
  const steps = [...entry.steps];
  const patternTicks = steps.length * stepTicks;
  if (patternTicks > clip.lengthTicks) {
    return refused(
      "steps",
      `${steps.length} steps of ${stepTicks} ticks is ${patternTicks} ticks, longer than the clip's ${clip.lengthTicks}; write one bar (or less) and it repeats to fill the clip`,
    );
  }
  const velocities = { ...DEFAULT_STEP_VELOCITIES, ...entry.velocity };
  const hitSteps = steps.flatMap((char, index) =>
    char === STEP_REST ? [] : [{ offset: index * stepTicks, char: char as StepHit }],
  );
  const hits: StepHitEvent[] = [];
  if (hitSteps.length === 0) return { ok: true, hits };
  for (let repeat = 0; repeat < clip.lengthTicks; repeat += patternTicks) {
    for (const { offset, char } of hitSteps) {
      const startTicks = repeat + offset;
      if (startTicks >= clip.lengthTicks) break;
      if (hits.length >= clip.maxHits) {
        return refused(
          "steps",
          `this string makes more notes than the ${clip.maxHits} this proposal has left; use a shorter clip and loop its placement`,
        );
      }
      hits.push({
        padId: entry.padId,
        startTicks,
        durationTicks: Math.min(stepTicks, clip.lengthTicks - startTicks),
        velocity: noteVelocity(velocities[char]),
      });
    }
  }
  return { ok: true, hits };
}

/** One hit as the domain note event it stands for. */
export function stepNoteEvent(hit: StepHitEvent, id: string): NoteEvent {
  return {
    id: id as NoteEvent["id"],
    trigger: { kind: "pad", padId: hit.padId } as NoteEvent["trigger"],
    startTicks: hit.startTicks as NoteEvent["startTicks"],
    durationTicks: hit.durationTicks as NoteEvent["durationTicks"],
    velocity: hit.velocity,
    probability: null,
  };
}

function refused(field: string | null, reason: string): StepExpansion {
  return { ok: false, field, reason };
}
