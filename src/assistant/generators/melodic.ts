/**
 * The melodic pattern generators (GRV-141): parts over a chord progression the
 * model names, each a pure function of primitive parameters that returns
 * compact note tuples (GRV-131, `../compactNotes.ts`) for the gateway's
 * existing expansion to turn into notes.
 *
 * - `arpeggio(chords, direction, rate, octaves)`: each chord's tones one at a
 *   time, up, down, up and down, or in a shuffled order, over `octaves` octaves.
 * - `chordStabs(chords, rhythm)`: the whole chord on each hit of a rhythm.
 * - `bassRoot(chords, rhythm, octave)`: each chord's root (or slash bass).
 *
 * **Harmony** is the call's: `chords` is a list of `[name, bars]`, parsed and
 * voiced by `chords.ts`, played from the clip's start and repeated to fill it.
 * A **rhythm** is a step string (x hit, X accent, o ghost, . rest) on
 * `stepTicks`, repeated from the clip's start; each hit plays the chord
 * sounding then, for one step. Without a rhythm, `chordStabs` and `bassRoot`
 * hold each chord for its length.
 *
 * Above `variation: 0` a generator moves velocities, drops the occasional note
 * (never a chord's first), adds the occasional one (a ghost on a rest, or an
 * arpeggio's note doubled an octave up) and swaps the occasional pair of an
 * arpeggio's notes, all drawn from the call's seeded randomness.
 *
 * Pure, with no Tone, Firebase or Solid.
 */
import { NOTE_VELOCITY } from "../../domain/parameters";
import {
  TICKS_PER_BAR,
  TICKS_PER_EIGHTH,
  TICKS_PER_EIGHTH_TRIPLET,
  TICKS_PER_QUARTER,
  TICKS_PER_SIXTEENTH,
} from "../../domain/time";
import {
  DEFAULT_STEP_TICKS,
  DEFAULT_STEP_VELOCITIES,
  MAX_STEP_VELOCITY,
  type StepHit,
} from "../drumSteps";
import {
  bassNote,
  MAX_MIDI_PITCH,
  type ParsedChord,
  parseChord,
  voiceChord,
} from "./chords";
import type { SeededRandom } from "./random";

/**
 * One note a melodic generator makes, as a compact note's first four numbers:
 * `[startTicks, pitch, durationTicks, velocity]`. The note expander checks it
 * against the compact note's schema as it writes it out.
 */
export type GeneratedNote = readonly [
  startTicks: number,
  pitch: number,
  durationTicks: number,
  velocity: number,
];

/** A chord as a call names it: its name and how many bars it lasts. */
export type ChordEntry = readonly [name: string, bars: number];

/** The note values an arpeggio steps at, by name, in ticks. */
export const ARPEGGIO_RATES = {
  "4th": TICKS_PER_QUARTER,
  "8th": TICKS_PER_EIGHTH,
  "16th": TICKS_PER_SIXTEENTH,
  "32nd": TICKS_PER_SIXTEENTH / 2,
  "8thTriplet": TICKS_PER_EIGHTH_TRIPLET,
  "16thTriplet": TICKS_PER_SIXTEENTH * (2 / 3),
} as const;
export type ArpeggioRate = keyof typeof ARPEGGIO_RATES;

export const ARPEGGIO_DIRECTIONS = ["up", "down", "upDown", "random"] as const;
export type ArpeggioDirection = (typeof ARPEGGIO_DIRECTIONS)[number];

/** The octave each generator voices in when the call names none, middle C being C4. */
export const DEFAULT_CHORD_OCTAVE = 4;
export const DEFAULT_BASS_OCTAVE = 2;

/** How often, at `variation: 1`, a note drops, a note is added, and an arpeggio's pair swaps. */
const DROP_CHANCE = 0.1;
const ADD_CHANCE = 0.08;
const SWAP_CHANCE = 0.25;
/** How far, at `variation: 1`, a velocity moves either way. */
const VELOCITY_SPREAD = 0.15;

/** One chord of the progression, where it starts and ends in it. */
interface ChordSpan {
  readonly chord: ParsedChord;
  readonly start: number;
  readonly end: number;
}

/** What a melodic generator works within: the clip, and the call's randomness. */
export interface MelodicContext {
  readonly lengthTicks: number;
  readonly random: SeededRandom;
  /** The most notes it may make. */
  readonly maxNotes: number;
}

/** A generator's notes, or why it makes none: the input's field at fault, and the reason. */
export type MelodicResult =
  | { readonly ok: true; readonly notes: GeneratedNote[] }
  | { readonly ok: false; readonly field: string; readonly reason: string };

interface MelodicInput {
  readonly chords: readonly ChordEntry[];
  readonly variation?: number;
}

export interface ArpeggioInput extends MelodicInput {
  readonly direction?: ArpeggioDirection;
  readonly rate?: ArpeggioRate;
  readonly octaves?: number;
  readonly octave?: number;
  readonly velocity?: number;
}

export interface RhythmInput extends MelodicInput {
  /** A step string, x hit, X accent, o ghost, . rest; each chord held when absent. */
  readonly rhythm?: string;
  readonly stepTicks?: number;
  readonly octave?: number;
}

class Refusal extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The progression as spans of ticks, or a refusal naming the chord at fault. */
function progressionOf(chords: readonly ChordEntry[], lengthTicks: number): ChordSpan[] {
  const spans: ChordSpan[] = [];
  let at = 0;
  for (const [index, [name, bars]] of chords.entries()) {
    const parsed = parseChord(name);
    if (!parsed.ok) throw new Refusal(`chords.${index}.0`, parsed.reason);
    const ticks = bars * TICKS_PER_BAR;
    if (!Number.isInteger(ticks) || ticks <= 0) {
      throw new Refusal(
        `chords.${index}.1`,
        `${bars} bars is not a whole number of ticks; a chord lasts a positive number of bars that comes to whole ticks (a bar is ${TICKS_PER_BAR}), e.g. 1, 0.5 or 0.25`,
      );
    }
    spans.push({ chord: parsed.chord, start: at, end: at + ticks });
    at += ticks;
  }
  if (at > lengthTicks) {
    throw new Refusal(
      "chords",
      `the chords last ${at / TICKS_PER_BAR} bars, longer than the clip's ${lengthTicks / TICKS_PER_BAR}; name the progression once (or less) and it repeats to fill the clip`,
    );
  }
  return spans;
}

/** Each chord of the progression as it falls in the clip, repeated to fill it. */
function chordsInClip(spans: readonly ChordSpan[], lengthTicks: number): ChordSpan[] {
  const cycle = spans[spans.length - 1]?.end ?? 0;
  const out: ChordSpan[] = [];
  if (cycle <= 0) return out;
  for (let repeat = 0; repeat < lengthTicks; repeat += cycle) {
    for (const span of spans) {
      const start = repeat + span.start;
      if (start >= lengthTicks) break;
      out.push({
        chord: span.chord,
        start,
        end: Math.min(repeat + span.end, lengthTicks),
      });
    }
  }
  return out;
}

/** A velocity rounded as a note's is, to three places, within the parameter's range. */
function noteVelocity(value: number): number {
  const clamped = Math.min(NOTE_VELOCITY.max, Math.max(NOTE_VELOCITY.min, value));
  return Math.round(clamped * 1000) / 1000;
}

/** `velocity` moved by up to the spread `variation` allows, or as it is at 0. */
function vary(velocity: number, variation: number, random: SeededRandom): number {
  if (variation <= 0) return noteVelocity(velocity);
  return noteVelocity(velocity + random.signed() * VELOCITY_SPREAD * variation);
}

function checkPitches(pitches: readonly number[], field: string): void {
  const bad = pitches.find((pitch) => pitch < 0 || pitch > MAX_MIDI_PITCH);
  if (bad !== undefined) {
    throw new Refusal(
      field,
      `the voicing reaches MIDI pitch ${bad}, outside 0 to ${MAX_MIDI_PITCH}; choose a lower or higher octave`,
    );
  }
}

/** Collects notes up to the context's limit. */
function collector(context: MelodicContext) {
  const notes: GeneratedNote[] = [];
  return {
    notes,
    push(note: GeneratedNote) {
      if (notes.length >= context.maxNotes) {
        throw new Refusal(
          "",
          `this generator makes more notes than the ${context.maxNotes} this proposal has left; use a shorter clip and loop its placement`,
        );
      }
      notes.push(note);
    },
  };
}

function run(make: () => GeneratedNote[]): MelodicResult {
  try {
    return { ok: true, notes: make() };
  } catch (error) {
    if (error instanceof Refusal)
      return { ok: false, field: error.field, reason: error.reason };
    throw error;
  }
}

/** The order an arpeggio plays `tones` (lowest first) in. */
function arpeggioOrder(
  tones: readonly number[],
  direction: ArpeggioDirection,
  random: SeededRandom,
): number[] {
  if (direction === "down") return [...tones].reverse();
  if (direction === "upDown") {
    return tones.length <= 2 ? [...tones] : [...tones, ...tones.slice(1, -1).reverse()];
  }
  if (direction === "random") {
    const shuffled = [...tones];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random.next() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    return shuffled;
  }
  return [...tones];
}

/** `order` with the occasional neighbouring pair swapped, `variation` saying how occasional. */
function swapSome(order: number[], variation: number, random: SeededRandom): number[] {
  if (variation <= 0) return order;
  const out = [...order];
  for (let index = 0; index + 1 < out.length; index += 1) {
    if (random.chance(SWAP_CHANCE * variation)) {
      [out[index], out[index + 1]] = [out[index + 1], out[index]];
      index += 1;
    }
  }
  return out;
}

/**
 * Each chord's tones one at a time at `rate`, over `octaves` octaves from its
 * root in `octave`, in `direction`'s order, starting again at each chord.
 * A note lasts one step, cut short where its chord ends.
 */
export function arpeggio(input: ArpeggioInput, context: MelodicContext): MelodicResult {
  return run(() => {
    const { random } = context;
    const variation = input.variation ?? 0;
    const rate = ARPEGGIO_RATES[input.rate ?? "16th"];
    const octaves = input.octaves ?? 1;
    const octave = input.octave ?? DEFAULT_CHORD_OCTAVE;
    const velocity = input.velocity ?? NOTE_VELOCITY.defaultValue;
    const out = collector(context);
    for (const span of chordsInClip(
      progressionOf(input.chords, context.lengthTicks),
      context.lengthTicks,
    )) {
      const voiced = voiceChord(span.chord, octave);
      const tones = Array.from({ length: octaves }, (_, up) =>
        voiced.map((pitch) => pitch + 12 * up),
      ).flat();
      checkPitches(tones, "octave");
      const order = swapSome(
        arpeggioOrder(tones, input.direction ?? "up", random),
        variation,
        random,
      );
      for (let at = span.start, step = 0; at < span.end; at += rate, step += 1) {
        if (step > 0 && random.chance(DROP_CHANCE * variation)) continue;
        const pitch = order[step % order.length];
        const start = Math.round(at);
        const duration = Math.round(Math.min(at + rate, span.end)) - start;
        if (duration <= 0) continue;
        const played = vary(velocity, variation, random);
        out.push([start, pitch, duration, played]);
        if (random.chance(ADD_CHANCE * variation) && pitch + 12 <= MAX_MIDI_PITCH) {
          out.push([start, pitch + 12, duration, played]);
        }
      }
    }
    return out.notes;
  });
}

/** One hit of a rhythm: where it falls and how hard. */
interface RhythmHit {
  readonly start: number;
  readonly end: number;
  readonly velocity: number;
}

/**
 * Where a part's notes fall: each hit of `rhythm` in the chord it lands in,
 * or, with no rhythm, each chord held for its length at the default velocity.
 * A rest may gain a ghost, and a hit (never a chord's first) may drop, above
 * `variation: 0`.
 */
function rhythmHits(
  input: RhythmInput,
  span: ChordSpan,
  context: MelodicContext,
): RhythmHit[] {
  const variation = input.variation ?? 0;
  const { random } = context;
  const scale = (hit: StepHit) => DEFAULT_STEP_VELOCITIES[hit] / MAX_STEP_VELOCITY;
  if (input.rhythm === undefined) {
    return [
      {
        start: span.start,
        end: span.end,
        velocity: vary(scale("x"), variation, random),
      },
    ];
  }
  const steps = [...input.rhythm];
  const stepTicks = input.stepTicks ?? DEFAULT_STEP_TICKS;
  const hits: RhythmHit[] = [];
  const first = Math.ceil(span.start / stepTicks);
  for (let index = first; index * stepTicks < span.end; index += 1) {
    const start = index * stepTicks;
    let char = steps[index % steps.length];
    if (char === ".") {
      if (!random.chance(ADD_CHANCE * variation)) continue;
      char = "o";
    } else if (hits.length > 0 && random.chance(DROP_CHANCE * variation)) {
      continue;
    }
    hits.push({
      start,
      end: Math.min(start + stepTicks, span.end),
      velocity: vary(scale(char as StepHit), variation, random),
    });
  }
  return hits;
}

/** The rhythm's length checked against the clip: a rhythm longer than the clip is refused. */
function checkRhythm(input: RhythmInput, lengthTicks: number): void {
  if (input.rhythm === undefined) return;
  const ticks = input.rhythm.length * (input.stepTicks ?? DEFAULT_STEP_TICKS);
  if (ticks > lengthTicks) {
    throw new Refusal(
      "rhythm",
      `${input.rhythm.length} steps of ${input.stepTicks ?? DEFAULT_STEP_TICKS} ticks is ${ticks} ticks, longer than the clip's ${lengthTicks}; write one bar (or less) and it repeats to fill the clip`,
    );
  }
}

/** A rhythmic part: `pitches` of the chord sounding on each hit. */
function rhythmicPart(
  input: RhythmInput,
  context: MelodicContext,
  pitches: (chord: ParsedChord) => number[],
): MelodicResult {
  return run(() => {
    checkRhythm(input, context.lengthTicks);
    const out = collector(context);
    for (const span of chordsInClip(
      progressionOf(input.chords, context.lengthTicks),
      context.lengthTicks,
    )) {
      const voiced = pitches(span.chord);
      checkPitches(voiced, "octave");
      for (const hit of rhythmHits(input, span, context)) {
        for (const pitch of voiced) {
          out.push([hit.start, pitch, hit.end - hit.start, hit.velocity]);
        }
      }
    }
    return out.notes;
  });
}

/** The whole chord, voiced in `octave`, on each hit of the rhythm. */
export function chordStabs(input: RhythmInput, context: MelodicContext): MelodicResult {
  const octave = input.octave ?? DEFAULT_CHORD_OCTAVE;
  return rhythmicPart(input, context, (chord) => voiceChord(chord, octave));
}

/** Each chord's root, or its slash bass, in `octave`, on each hit of the rhythm. */
export function bassRoot(input: RhythmInput, context: MelodicContext): MelodicResult {
  const octave = input.octave ?? DEFAULT_BASS_OCTAVE;
  return rhythmicPart(input, context, (chord) => [bassNote(chord, octave)]);
}
