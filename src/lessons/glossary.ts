/**
 * What the words in a lesson mean (GRV-43). A step writes a term as
 * `[the words](term-id)`; the lesson draws it as a button that shows the
 * definition under the step, without leaving it.
 *
 * Each definition is one or two plain sentences, the way Coproducer would say
 * it beside you; Coproducer itself fits its own explanations to how much the
 * producer has made. A term that names one of the studio's views opens it as
 * well (GRV-190): "the Library" in a step is a way to the Library.
 */
import type { EditorViewName } from "../analytics/catalog";

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
  /** The view the term names, which pressing it opens. */
  readonly view?: EditorViewName;
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
    view: "library",
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
    view: "arrangement",
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
    view: "sequence",
  },
  instrument: {
    term: "Instrument view",
    definition:
      "The faceplate of the selected track's instrument: its sounds and every control that shapes them.",
    view: "instrument",
  },
  mixer: {
    term: "Mixer",
    definition:
      "Every track's volume, pan and effects side by side, and where you add a new track.",
    view: "mixer",
  },
  dock: {
    term: "dock",
    definition:
      "The row of five view tiles. Each has a key, 1 to 5, that takes you there.",
  },
  key: {
    term: "key",
    definition:
      "The scale a song is written in: which notes belong. Pick one and every part agrees, so nothing clashes.",
  },
  "piano-roll": {
    term: "piano roll",
    definition:
      "Where a synth's notes are written: pitch up the side, time along the bottom. Draw a note to add it.",
  },
  bassline: {
    term: "bassline",
    definition:
      "The low part that holds a track up from under the beat. Locked to the kick, the two hit as one.",
  },
  root: {
    term: "root",
    definition: "The note a key is named after, its home: A in A minor.",
  },
  chord: {
    term: "chord",
    definition:
      "Three or more notes played together. A loop of a few chords is what a track's harmony usually is.",
  },
  hook: {
    term: "hook",
    definition:
      "The short, catchy part you hum after one listen: a melody, a riff, a vocal line.",
  },
  duplicate: {
    term: "duplicate",
    definition:
      "Copies what is selected right after itself. Press it again and the copy is copied, so a loop doubles each time.",
  },
  intro: {
    term: "intro",
    definition:
      "The start of a song, holding the hook back: the beat and the bass set the groove before everything arrives.",
  },
  breakdown: {
    term: "breakdown",
    definition:
      "A stretch with the drums taken out, so what is left can breathe and the listener misses the beat.",
  },
  drop: {
    term: "drop",
    definition:
      "The moment everything comes back at once after a breakdown, the biggest part of a dance track.",
  },
  outro: {
    term: "outro",
    definition:
      "The end of a song, where parts drop away so it finishes rather than stops. DJs mix out of it.",
  },
  balance: {
    term: "balance",
    definition:
      "How loud each part is against the others. Get it right and every part is heard in its place.",
  },
  fader: {
    term: "fader",
    definition: "The slider that sets a track's volume on its strip in the Mixer.",
  },
  pan: {
    term: "pan",
    definition:
      "Where a sound sits between the left and right speakers. Moving parts apart gives each room.",
  },
  reverb: {
    term: "reverb",
    definition:
      "The sound of a room: the reflections after a note that make it feel near or far, small or huge.",
  },
  return: {
    term: "return",
    definition:
      "A strip in the Mixer for an effect any track can share: tracks send some of their sound to it.",
  },
  send: {
    term: "send",
    definition:
      "How much of a track goes to a return's effect, beside its own sound. Turn it up for more of the effect.",
  },
  master: {
    term: "master",
    definition:
      "Where every track ends up: the whole mix, on its own strip at the right of the Mixer. Its meter goes red if the mix clips.",
  },
  stems: {
    term: "stems",
    definition:
      "The song exported as one audio file per track, all lined up from bar 1, so each part can be worked on alone.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermId = keyof typeof GLOSSARY;

export function isTermId(value: string): value is TermId {
  return Object.hasOwn(GLOSSARY, value);
}

/** The view a term names, which pressing it opens, or null. */
export function termView(id: TermId): EditorViewName | null {
  const entry: GlossaryEntry = GLOSSARY[id];
  return entry.view ?? null;
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
