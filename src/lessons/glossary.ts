/**
 * What the words in a lesson mean (GRV-43). A step writes a term as
 * `[the words](term-id)`; the lesson draws it as a button that shows the
 * definition under the step, without leaving it.
 *
 * Each definition is one or two plain sentences, the way Coproducer would say
 * it beside you; Coproducer itself fits its own explanations to how much the
 * producer has made.
 */

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export const GLOSSARY = {
  kick: {
    term: "kick",
    definition:
      "The kick drum: the low thump that tells your body where the beat is. Most beats start from it.",
  },
  "four-on-the-floor": {
    term: "four on the floor",
    definition:
      "A kick on every beat of the bar, one-two-three-four. It is the heartbeat of house, techno and disco.",
  },
  "boom-bap": {
    term: "boom bap",
    definition:
      'The classic hip hop beat: a heavy kick ("boom") and a hard snare ("bap") on 2 and 4, at a laid-back tempo around 90 BPM.',
  },
  trap: {
    term: "trap",
    definition:
      "A hip hop style from Atlanta: fast hats, booming kicks and the snare on beat 3, so at around 140 BPM it feels half as fast.",
  },
  library: {
    term: "Library",
    definition:
      "Every sound Groove has, in packs. Press a sound to hear it, and put it on a pad or a sampler.",
  },
  pad: {
    term: "pad",
    definition:
      "One sound on a drum machine, like one drum in a kit. Each pad has its own row of steps.",
  },
  step: {
    term: "step",
    definition:
      "One sixteenth of a bar. Sixteen steps make a bar: steps 1, 5, 9 and 13 are its four beats.",
  },
  beat: {
    term: "beat",
    definition:
      "One count of the bar. A bar of 4/4 has four, and each beat is four steps long.",
  },
  tempo: {
    term: "tempo",
    definition:
      "How fast the song goes, in beats per minute (BPM). Each style has a home: house around 124, boom bap around 90, trap around 140.",
  },
  play: {
    term: "Play",
    definition:
      "Starts the song from the playhead. Space does the same, and stops it again.",
  },
  snare: {
    term: "snare",
    definition:
      "The sharp crack that answers the kick. A clap does the same job in a lot of dance music.",
  },
  backbeat: {
    term: "backbeat",
    definition:
      "The snare or clap on beats 2 and 4, against the kick. It is what makes you nod your head.",
  },
  "hi-hat": {
    term: "hats",
    definition:
      "Hi-hats: the short, bright ticks that keep time between the kick and the snare.",
  },
  "off-beat": {
    term: "off-beat",
    definition: 'The "and" halfway between two beats. A hat there pushes a beat forward.',
  },
  clip: {
    term: "clip",
    definition:
      "A block of notes on a track. A clip can loop, so one bar can play for as long as you like.",
  },
  arrangement: {
    term: "arrangement",
    definition:
      "The whole song laid out in time: every track's clips, from the first bar to the last.",
  },
  synth: {
    term: "synth",
    definition:
      "An instrument that makes its sound from scratch, from an oscillator you shape, rather than playing a recording.",
  },
  waveform: {
    term: "waveform",
    definition:
      "The shape of the oscillator's wave, which sets the raw tone: sine is pure, triangle soft, square hollow and saw bright.",
  },
  filter: {
    term: "filter",
    definition:
      "Takes away part of the sound. This one is a low-pass: it lets the lows through and cuts the highs above its cutoff.",
  },
  cutoff: {
    term: "cutoff",
    definition:
      "Where the filter starts cutting. Lower it and the sound gets darker and rounder.",
  },
  envelope: {
    term: "envelope",
    definition:
      "How a note's volume moves over time: how fast it starts (attack), falls (decay), holds (sustain) and fades out (release).",
  },
  attack: {
    term: "attack",
    definition: "How long a note takes to reach full volume. Short is snappy.",
  },
  decay: {
    term: "decay",
    definition: "How long a note takes to fall from its peak to the sustain level.",
  },
  sustain: {
    term: "sustain",
    definition:
      "The level a note holds at while the key stays down. At zero, the note dies away on its own.",
  },
  pluck: {
    term: "pluck",
    definition:
      "A sound that starts hard and dies away fast, like a plucked string: no sustain, a short decay.",
  },
  sequence: {
    term: "Sequence view",
    definition:
      "Where you write a clip's notes: a step grid for drums, a piano roll for everything else.",
  },
  instrument: {
    term: "Instrument view",
    definition:
      "The faceplate of the selected track's instrument: its sounds and every control that shapes them.",
  },
  mixer: {
    term: "Mixer",
    definition:
      "Every track's volume, pan and effects side by side, and where you add a new track.",
  },
  dock: {
    term: "dock",
    definition:
      "The row of five view tiles. Each has a key, 1 to 5, that takes you there.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermId = keyof typeof GLOSSARY;

export function isTermId(value: string): value is TermId {
  return Object.hasOwn(GLOSSARY, value);
}

/** One run of a step's text: plain words, or a term to tap. */
export type InstructionPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "term"; readonly text: string; readonly term: TermId };

const TERM = /\[([^\]]+)\]\(([a-z-]+)\)/g;

/**
 * A step's instruction as runs of text and terms. A term naming an entry the
 * glossary does not have is left as its words.
 */
export function instructionParts(instruction: string): InstructionPart[] {
  const parts: InstructionPart[] = [];
  let last = 0;
  for (const match of instruction.matchAll(TERM)) {
    const [whole, text, id] = match;
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: instruction.slice(last, at) });
    parts.push(isTermId(id) ? { kind: "term", text, term: id } : { kind: "text", text });
    last = at + whole.length;
  }
  if (last < instruction.length)
    parts.push({ kind: "text", text: instruction.slice(last) });
  return mergeText(parts);
}

function mergeText(parts: readonly InstructionPart[]): InstructionPart[] {
  const merged: InstructionPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.kind === "text" && previous?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: previous.text + part.text };
    } else merged.push(part);
  }
  return merged;
}

/** A step's instruction as plain words, as Coproducer is told it. */
export function plainInstruction(instruction: string): string {
  return instructionParts(instruction)
    .map((part) => part.text)
    .join("");
}
