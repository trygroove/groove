/**
 * Pattern generators the model asks for by intent (GRV-141), behind the
 * `patternGenerators` tactic.
 *
 * The model spends output and thinking working out the notes of patterns it
 * could just name. With the tactic on, an entry in `clip_create`'s
 * `content.events` may be a generator call instead of notes written out:
 *
 * ```
 * { generator: "euclidean", padId: "pad_...", hits: 5, steps: 16, rotate: 2 }
 * { generator: "arpeggio", chords: [["Am", 1], ["F", 1]], direction: "upDown", rate: "16th" }
 * ```
 *
 * The drum generators (`drums.ts`) return a step string and the melodic ones
 * (`melodic.ts`) compact note tuples; the gateway's note expander
 * (`../compactNotes.ts`) writes those out as it writes the model's own, with
 * the same deterministic IDs and the same refusal path, so nothing past the
 * gateway ever sees a generator call. Every generator takes primitive
 * parameters (no genre presets), and an optional `variation` drawn from a
 * seed the expander makes from the turn's ID stem and the call's position.
 *
 * Pure, with no Tone, Firebase or Solid.
 */
import { z } from "zod";
import { MAX_CLIP_LENGTH_BARS, MIN_CLIP_LENGTH_BARS } from "../../domain/clipLength";
import { padIdSchema } from "../../domain/ids";
import { NOTE_VELOCITY, parameterValueSchema } from "../../domain/parameters";
import { TICKS_PER_BAR } from "../../domain/time";
import { DEFAULT_STEP_TICKS, drumStepsSchema, MAX_STEP_VELOCITY } from "../drumSteps";
import { CHORD_QUALITIES_TEXT } from "./chords";
import {
  backbeat,
  DRUM_GRID_TICKS,
  euclidean,
  fourOnTheFloor,
  type GeneratedSteps,
  HAT_RATES,
  hats,
} from "./drums";
import {
  ARPEGGIO_DIRECTIONS,
  ARPEGGIO_RATES,
  type ArpeggioRate,
  arpeggio,
  bassRoot,
  chordStabs,
  DEFAULT_BASS_OCTAVE,
  DEFAULT_CHORD_OCTAVE,
  type GeneratedNote,
  type MelodicResult,
} from "./melodic";
import { seededRandom } from "./random";

/** How far `variation` goes: 0 exact, 1 the most it moves. */
export const MAX_VARIATION = 1;

/** The most steps a Euclidean cycle may have. */
export const MAX_EUCLIDEAN_STEPS = 64;

/** The octaves an arpeggio may climb, and the octave any melodic generator may voice in. */
export const MAX_ARPEGGIO_OCTAVES = 4;
export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 8;

/** The most chords one call may name, and the longest name. */
export const MAX_CHORDS = 64;
const MAX_CHORD_NAME_LENGTH = 16;

const variationSchema = z.number().min(0).max(MAX_VARIATION).optional();
const barsSchema = z.int().min(MIN_CLIP_LENGTH_BARS).max(MAX_CLIP_LENGTH_BARS).optional();
const stepVelocitySchema = drumStepsSchema.shape.velocity;
const octaveSchema = z.int().min(MIN_OCTAVE).max(MAX_OCTAVE).optional();
const stepTicksSchema = z.int().positive().optional();
const chordsSchema = z
  .array(z.tuple([z.string().min(1).max(MAX_CHORD_NAME_LENGTH), z.number().positive()]))
  .min(1)
  .max(MAX_CHORDS);
const rhythmSchema = z
  .string()
  .min(1)
  .regex(/^[xXo.]+$/, "only x (hit), X (accent), o (ghost) and . (rest)")
  .optional();

const drumPart = {
  padId: padIdSchema,
  bars: barsSchema,
  velocity: stepVelocitySchema,
  variation: variationSchema,
};

const rhythmPart = {
  chords: chordsSchema,
  rhythm: rhythmSchema,
  stepTicks: stepTicksSchema,
  octave: octaveSchema,
  variation: variationSchema,
};

/** Every generator's call, by name. */
export const GENERATOR_SCHEMAS = {
  fourOnTheFloor: z.strictObject({
    generator: z.literal("fourOnTheFloor"),
    ...drumPart,
  }),
  backbeat: z.strictObject({ generator: z.literal("backbeat"), ...drumPart }),
  hats: z.strictObject({
    generator: z.literal("hats"),
    ...drumPart,
    rate: z.enum(HAT_RATES),
  }),
  euclidean: z.strictObject({
    generator: z.literal("euclidean"),
    padId: padIdSchema,
    hits: z.int().min(0).max(MAX_EUCLIDEAN_STEPS),
    steps: z.int().min(1).max(MAX_EUCLIDEAN_STEPS),
    rotate: z.int().min(0).optional(),
    stepTicks: stepTicksSchema,
    velocity: stepVelocitySchema,
    variation: variationSchema,
  }),
  arpeggio: z.strictObject({
    generator: z.literal("arpeggio"),
    chords: chordsSchema,
    direction: z.enum(ARPEGGIO_DIRECTIONS).optional(),
    rate: z
      .enum(Object.keys(ARPEGGIO_RATES) as [ArpeggioRate, ...ArpeggioRate[]])
      .optional(),
    octaves: z.int().min(1).max(MAX_ARPEGGIO_OCTAVES).optional(),
    octave: octaveSchema,
    velocity: parameterValueSchema(NOTE_VELOCITY).optional(),
    variation: variationSchema,
  }),
  chordStabs: z.strictObject({ generator: z.literal("chordStabs"), ...rhythmPart }),
  bassRoot: z.strictObject({ generator: z.literal("bassRoot"), ...rhythmPart }),
} as const;

export type GeneratorName = keyof typeof GENERATOR_SCHEMAS;
export type { GeneratedNote, GeneratedSteps };
export const GENERATOR_NAMES = Object.keys(GENERATOR_SCHEMAS) as GeneratorName[];
const DRUM_GENERATORS: readonly GeneratorName[] = [
  "fourOnTheFloor",
  "backbeat",
  "hats",
  "euclidean",
];

/**
 * What the tools say a generator call is. Said once, in `clip_create`'s
 * description, not again on the schema, so it costs its input tokens once.
 */
export const GENERATORS_DESCRIPTION = [
  `A pattern generator in place of notes written out, {generator, ...}: Groove writes its notes, the same every time, repeating them from the clip's start to its end.`,
  `Drums, on a drum machine (padId one of its pads, bars ${MIN_CLIP_LENGTH_BARS} to ${MAX_CLIP_LENGTH_BARS}, default 1): fourOnTheFloor {padId, bars}; backbeat {padId, bars} (beats 2 and 4); hats {padId, rate: ${HAT_RATES.join(" | ")}, bars}; euclidean {padId, hits, steps (up to ${MAX_EUCLIDEAN_STEPS}), rotate, stepTicks (default ${DRUM_GRID_TICKS})}, hits spread evenly over steps, rotate moving them later. velocity sets {x, X, o}, a hit, an accent and a ghost, on a MIDI scale of 1 to ${MAX_STEP_VELOCITY}.`,
  `Melodic, on a pitched track: chords is [[name, bars], ...], e.g. [["Am", 1], ["F", 1], ["C", 1], ["G", 1]]; a name is a root A to G, then ${CHORD_QUALITIES_TEXT}. arpeggio {chords, direction: ${ARPEGGIO_DIRECTIONS.join(" | ")}, rate: ${Object.keys(ARPEGGIO_RATES).join(" | ")}, octaves 1 to ${MAX_ARPEGGIO_OCTAVES}, octave, velocity 0 to 1}; chordStabs {chords, rhythm, stepTicks, octave}; bassRoot {chords, rhythm, stepTicks, octave}. rhythm is one character a step, x a hit, X an accent, o a ghost, . a rest, each hit one step of stepTicks (default ${DEFAULT_STEP_TICKS}); without one each chord is held. octave puts the root in that octave, middle C in 4 (default ${DEFAULT_CHORD_OCTAVE}, a bass ${DEFAULT_BASS_OCTAVE}).`,
  `variation, 0 to ${MAX_VARIATION} (default 0, exact), moves velocities and drops or adds the odd note. Add, edit or remove notes after as usual.`,
].join(" ");

/** One generator call as the model writes it. */
export const generatorCallSchema = z.discriminatedUnion("generator", [
  GENERATOR_SCHEMAS.fourOnTheFloor,
  GENERATOR_SCHEMAS.backbeat,
  GENERATOR_SCHEMAS.hats,
  GENERATOR_SCHEMAS.euclidean,
  GENERATOR_SCHEMAS.arpeggio,
  GENERATOR_SCHEMAS.chordStabs,
  GENERATOR_SCHEMAS.bassRoot,
]);
export type GeneratorCall = z.infer<typeof generatorCallSchema>;

/** Whether `value` is meant as a generator call: an object with a `generator` field. */
export function isGeneratorEntry(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "generator")
  );
}

/** What a generator call is written into: its clip, its track's pads, and its seed. */
export interface GeneratorClip {
  readonly trackId: string;
  /** The clip's length, already checked to be one a clip may have. */
  readonly lengthTicks: number;
  /** The track's pads; empty or undefined for a track that is not a drum machine. */
  readonly pads: ReadonlySet<string> | undefined;
  /** The seed of the call's variation: the same seed, the same notes. */
  readonly seed: string;
  /** The most notes it may make: what is left of the turn's. */
  readonly maxNotes: number;
}

/** What a generator call makes: step strings and tuples, for the note expander to write out. */
export type GeneratorExpansion =
  | { readonly ok: true; readonly entries: readonly (GeneratedNote | GeneratedSteps)[] }
  | {
      readonly ok: false;
      /** The call's field at fault, or null for the call as a whole. */
      readonly field: string | null;
      readonly reason: string;
    };

function refused(field: string | null, reason: string): GeneratorExpansion {
  return { ok: false, field, reason };
}

function fromMelodic(result: MelodicResult): GeneratorExpansion {
  return result.ok
    ? { ok: true, entries: result.notes }
    : refused(result.field || null, result.reason);
}

/** Why `raw` does not parse as a generator call, said for the model. */
function parseIssue(raw: unknown): GeneratorExpansion {
  const name = isGeneratorEntry(raw) ? raw.generator : undefined;
  if (typeof name !== "string" || !Object.hasOwn(GENERATOR_SCHEMAS, name)) {
    return refused(
      "generator",
      `${JSON.stringify(typeof name === "string" ? name.slice(0, 32) : name)} is not a generator; use one of ${GENERATOR_NAMES.join(", ")}`,
    );
  }
  const parsed = GENERATOR_SCHEMAS[name as GeneratorName].safeParse(raw);
  const issue = parsed.success ? undefined : parsed.error.issues[0];
  return refused(
    issue?.path.join(".") || null,
    `${issue?.message ?? "not a generator call"}; ${name} takes ${Object.keys(
      GENERATOR_SCHEMAS[name as GeneratorName].shape,
    )
      .filter((key) => key !== "generator")
      .join(", ")}`,
  );
}

/**
 * What the generator call `raw` makes in `clip`, or why it is refused: an
 * unknown generator or parameter, a value out of range, more hits than steps,
 * a pattern longer than the clip, a drum generator on a track with no pads or
 * a melodic one on a drum machine, or an unknown chord. The same call with
 * the same seed always makes the same entries.
 */
export function expandGenerator(raw: unknown, clip: GeneratorClip): GeneratorExpansion {
  const parsed = generatorCallSchema.safeParse(raw);
  if (!parsed.success) return parseIssue(raw);
  const call = parsed.data;
  const random = seededRandom(clip.seed);
  const drum = DRUM_GENERATORS.includes(call.generator);
  const isKit = (clip.pads?.size ?? 0) > 0;
  if (!drum && isKit) {
    return refused(
      "generator",
      `the track "${clip.trackId.slice(0, 64)}" is a drum machine; ${call.generator} is for a pitched track. On a drum machine use ${DRUM_GENERATORS.join(", ")}`,
    );
  }
  const melodic = { lengthTicks: clip.lengthTicks, random, maxNotes: clip.maxNotes };
  switch (call.generator) {
    case "fourOnTheFloor":
    case "backbeat":
    case "hats": {
      const bars = call.bars ?? 1;
      if (bars * TICKS_PER_BAR > clip.lengthTicks) {
        return refused(
          "bars",
          `${bars} bars is longer than the clip's ${clip.lengthTicks / TICKS_PER_BAR}; the part repeats to fill the clip, so ask for a bar`,
        );
      }
      const steps =
        call.generator === "hats"
          ? hats(call, random)
          : call.generator === "backbeat"
            ? backbeat(call, random)
            : fourOnTheFloor(call, random);
      return { ok: true, entries: [steps] };
    }
    case "euclidean": {
      if (call.hits > call.steps) {
        return refused(
          "hits",
          `${call.hits} hits do not fit in ${call.steps} steps; a Euclidean rhythm has at most one hit a step`,
        );
      }
      const stepTicks = call.stepTicks ?? DRUM_GRID_TICKS;
      if (call.steps * stepTicks > clip.lengthTicks) {
        return refused(
          "steps",
          `${call.steps} steps of ${stepTicks} ticks is ${call.steps * stepTicks} ticks, longer than the clip's ${clip.lengthTicks}; the cycle repeats to fill the clip`,
        );
      }
      return { ok: true, entries: [euclidean(call, random)] };
    }
    case "arpeggio":
      return fromMelodic(arpeggio(call, melodic));
    case "chordStabs":
      return fromMelodic(chordStabs(call, melodic));
    case "bassRoot":
      return fromMelodic(bassRoot(call, melodic));
  }
}
