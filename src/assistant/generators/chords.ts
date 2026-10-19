/**
 * Chord names as the melodic pattern generators read them (GRV-141).
 *
 * Harmony comes from the model: an `arpeggio`, `chordStabs` or `bassRoot` call
 * names its chords (`[["Am", 1], ["F", 1], ["C", 1], ["G", 1]]`), and the
 * generator parses and voices each one. Nothing here reads the song's key.
 *
 * A name is a root (A to G, then `#` or `b`), a quality, and an optional slash
 * bass (`C/E`, `Bb/D`). The qualities are the majors, minors, 7ths and sus
 * chords below; anything else (`Cadd9`, `C13`, `H`) is refused with the reason,
 * so the model can rename it rather than get a chord it did not ask for.
 *
 * Pure, with no Tone, Firebase or Solid.
 */

/** The highest MIDI pitch, which a voiced note may not pass. */
export const MAX_MIDI_PITCH = 127;

/** Each quality Groove voices, by every spelling it takes, as semitones over the root. */
const QUALITIES: Readonly<Record<string, readonly number[]>> = {
  "": [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  "-": [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  "+": [0, 4, 8],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  "-7": [0, 3, 7, 10],
  mMaj7: [0, 3, 7, 11],
  mM7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus: [0, 5, 7],
  "7sus4": [0, 5, 7, 10],
  "7sus": [0, 5, 7, 10],
};

/** What a refusal lists as the qualities there are. */
export const CHORD_QUALITIES_TEXT =
  "major (C), minor (Cm), dim, aug, 7, maj7, m7, mMaj7, dim7, m7b5, sus2, sus4 and 7sus4, a root's # or b, and a slash bass (C/E)";

const NOTE_CLASSES: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const CHORD_PATTERN = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/;

/** A chord as its name says it: pitch classes, not yet voiced in an octave. */
export interface ParsedChord {
  readonly name: string;
  /** The root's pitch class, 0 (C) to 11 (B). */
  readonly root: number;
  /** Semitones over the root, lowest first. */
  readonly intervals: readonly number[];
  /** The slash bass's pitch class, or null when the name has none. */
  readonly bass: number | null;
}

export type ChordParse =
  | { readonly ok: true; readonly chord: ParsedChord }
  | { readonly ok: false; readonly reason: string };

function pitchClass(letter: string, accidental: string): number {
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return (NOTE_CLASSES[letter] + shift + 12) % 12;
}

/** `name` parsed, or why Groove does not voice it. */
export function parseChord(name: string): ChordParse {
  const shown = JSON.stringify(name.slice(0, 32));
  const match = CHORD_PATTERN.exec(name);
  if (!match) {
    return {
      ok: false,
      reason: `${shown} is not a chord: a chord name starts with its root, A to G, then # or b if it has one, e.g. Am, F#m7, Bb/D`,
    };
  }
  const [, letter, accidental, quality, bassLetter, bassAccidental] = match;
  const intervals = Object.hasOwn(QUALITIES, quality) ? QUALITIES[quality] : undefined;
  if (!intervals) {
    return {
      ok: false,
      reason: `${shown} is not a chord Groove voices: "${quality.slice(0, 16)}" is not a quality it knows. Use ${CHORD_QUALITIES_TEXT}`,
    };
  }
  return {
    ok: true,
    chord: {
      name,
      root: pitchClass(letter, accidental),
      intervals,
      bass: bassLetter === undefined ? null : pitchClass(bassLetter, bassAccidental),
    },
  };
}

/** The MIDI pitch of pitch class `pitchClass` in `octave`, middle C being C4 (60). */
export function pitchIn(pitchClassValue: number, octave: number): number {
  return 12 * (octave + 1) + pitchClassValue;
}

/**
 * `chord` voiced in close root position with its root in `octave`, lowest
 * first. A slash bass sounds below the root, the nearest such pitch.
 */
export function voiceChord(chord: ParsedChord, octave: number): number[] {
  const root = pitchIn(chord.root, octave);
  const tones = chord.intervals.map((interval) => root + interval);
  if (chord.bass === null) return tones;
  const below = (chord.root - chord.bass + 12) % 12 || 12;
  return [root - below, ...tones];
}

/** The lowest note of `chord` in `octave`: its slash bass, else its root. */
export function bassNote(chord: ParsedChord, octave: number): number {
  return pitchIn(chord.bass ?? chord.root, octave);
}
