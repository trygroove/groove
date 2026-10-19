/**
 * Which tool bundle a turn is offered under the `toolBundles` tactic
 * (GRV-143): a pure rule over the request, with no model call.
 *
 * It reads three things the request already carries:
 *
 * - **the scope's level** (`selection`, `track` or `song`), read off the
 *   context the composer's scope chip built (`src/editor/assistant/
 *   assistantScope.ts`): no selection is the whole song, a selection of
 *   tracks alone is a track, anything else (notes, clips) is a selection;
 * - **the selected tracks' kinds**, from the context's tracks;
 * - **the words of the producer's last message**.
 *
 * The words vote for the families a request names: the mix and the sound,
 * notes, or the arrangement. A message whose words name exactly one family
 * gets that family's bundle; one that names none, more than one, or a whole
 * new part (a new track, a beat, a song, a sketch) gets `everything`. Writing
 * a new part (a melody, a bassline, a pattern) is the notes bundle only where
 * there is an instrument track in scope to write it on: on the whole song it
 * may need a track first. Unsure is always `everything`, so a wrong guess
 * costs the turn a `need_more_tools` call at worst.
 */
import type { AssistantTurnRequest } from "./protocol";
import { EVERYTHING_BUNDLE, type ToolBundleId } from "./tools";

/** How wide the turn's scope is, as `assistantScope.ts` names it. */
export type BundleScopeLevel = "selection" | "track" | "song";

/** What the rule reads of a request. */
export interface BundleSignals {
  readonly level: BundleScopeLevel;
  /**
   * The instrument kind of each track in scope (`null` for a track with no
   * instrument, such as an audio track); empty when no track is.
   */
  readonly trackKinds: readonly ("sampler" | "synth" | "drumMachine" | null)[];
  /** The producer's last message. */
  readonly message: string;
}

/** Words that ask for a whole new part, which may take any tool. */
const BROAD = [
  /\bnew (track|part|instrument|layer|song|beat|idea|section)s?\b/,
  /\banother (track|part|instrument|layer)\b/,
  /\b(sketch|song|songs|beat|beats|tune|from scratch|full track|whole track|develop|flesh out|finish)\b/,
];

/** The mix and the sound: levels, panning, effects, instruments, samples. */
const MIX = [
  /\b(mix|mixing|remix|louder|quieter|softer|loud|quiet|volume|volumes|levels?|gain|fader|balance)\b/,
  /\b(pan|panned|panning|stereo|wider|width|narrow(er)?)\b/,
  /\b(mute|muted|unmute|solo|soloed|unsolo)\b/,
  /\b(reverb|delay|echo|eq|equali[sz]e|compress(ion|or)?|sidechain|distortion|distort|saturat(e|ion)|overdrive|limiter|bitcrush(er)?)\b/,
  /\b(effects?|fx|devices?|bypass|send|sends|return|returns|bus|master)\b/,
  /\b(filter|cutoff|resonance|envelope|attack|decay|release|sustain|lfo|oscillator|detune)\b/,
  /\b(brighter|darker|warmer|colder|muddy|harsh|boomy|thinner|fatter|punchier|punch)\b/,
  /\b(sample|samples|instrument|synth|sampler|patch|preset|sound design|timbre|tone)\b/,
];

/** Editing notes that are already there. */
const NOTE_EDITS = [
  /\b(notes?|quanti[sz]e|quantised|quantized|transpose|octave|semitones?)\b/,
  /\b(humani[sz]e|velocity|velocities|accents?|ghost notes?|timing|tighten|tighter|sloppy|looser|on the grid)\b/,
  /\b(scale|in key|key of|out of key|vary|variation|randomi[sz]e|thin out|denser|sparser|busier|simpler)\b/,
];

/** Writing a part: notes that are not there yet. */
const NOTE_WRITES = [
  /\b(melody|melodies|melodic|bassline|bass line|riff|hook|motif|lick)\b/,
  /\b(chords?|progression|harmony|harmoni[sz]e|arpeggio|arpeggiate|arp)\b/,
  /\b(pattern|rhythm|fill|fills|groove|counter ?melody|phrase)\b/,
];

/** The arrangement: tracks, sections, placements, tempo. */
const ARRANGE = [
  /\b(arrange|arrangement|structure|sections?|intro|outro|verse|chorus|bridge|drop|breakdown|build ?up|pre-chorus)\b/,
  /\b(extend|lengthen|longer|shorter|repeat|duplicate|copy|move|reorder|rename|recolou?r)\b/,
  /\b(tempo|bpm|faster|slower|speed up|slow down|swing|shuffle)\b/,
  /\b(delete|remove) (the |this |that )?(track|clip)s?\b/,
];

type Family = "mix" | "notesEdit" | "notesWrite" | "arrange";

const FAMILIES: Readonly<Record<Family, readonly RegExp[]>> = {
  mix: MIX,
  notesEdit: NOTE_EDITS,
  notesWrite: NOTE_WRITES,
  arrange: ARRANGE,
};

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** The message as the patterns read it: lower case, single spaces, hyphens as spaces. */
function normalise(message: string): string {
  return message
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The bundle `signals` call for. Pure: the same signals always pick the same
 * bundle.
 */
export function chooseToolBundle(signals: BundleSignals): ToolBundleId {
  const text = normalise(signals.message);
  if (text.length === 0 || matches(text, BROAD)) return EVERYTHING_BUNDLE;
  const named = (Object.keys(FAMILIES) as Family[]).filter((family) =>
    matches(text, FAMILIES[family]),
  );
  const families = new Set(
    named.map((family) => (family === "mix" || family === "arrange" ? family : "notes")),
  );
  if (families.size !== 1) return EVERYTHING_BUNDLE;
  const [family] = families;
  if (family !== "notes") return family as ToolBundleId;
  // A new part is written on an instrument track already in scope; on the
  // whole song, or over a track with no instrument, it may need a track first.
  if (named.includes("notesWrite")) {
    const writable =
      signals.level !== "song" &&
      signals.trackKinds.length > 0 &&
      signals.trackKinds.every((kind) => kind !== null);
    if (!writable) return EVERYTHING_BUNDLE;
  }
  return "notes";
}

/**
 * What the rule reads of `turn`: the scope's level, the kinds of the tracks
 * in scope, and the producer's last message.
 */
export function bundleSignals(turn: AssistantTurnRequest): BundleSignals {
  const { context } = turn;
  const message = turn.messages[turn.messages.length - 1]?.text ?? "";
  const selection = context.selection;
  if (!selection) return { level: "song", trackKinds: [], message };
  const kinds = Object.keys(selection.countByKind).filter(
    (kind) => (selection.countByKind[kind] ?? 0) > 0,
  );
  const level: BundleScopeLevel =
    kinds.length > 0 && kinds.every((kind) => kind === "track") ? "track" : "selection";
  // A track is in scope when its ID is in the selection's description (the
  // composer's track scope names it) or its notes are among those sent.
  const inScope = new Set(context.selectedNotes?.clips.map((clip) => clip.trackId) ?? []);
  const trackKinds = context.tracks
    .filter((track) => inScope.has(track.id) || selection.description.includes(track.id))
    .map((track) => track.instrumentKind);
  return { level, trackKinds, message };
}

/** The bundle a turn is offered under `toolBundles=bundled`. */
export function toolBundleFor(turn: AssistantTurnRequest): ToolBundleId {
  return chooseToolBundle(bundleSignals(turn));
}
