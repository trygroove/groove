/**
 * The checks only some assistant eval cases name (GRV-99), beside the shared
 * ones in `checks.ts`. Each is a code check, a pure function of the fixture,
 * the project the proposal leaves and the reply's text, with no LLM judge:
 *
 * - {@link checkOutcome}: the turn did what the case expects, a proposal or a
 *   question (`ask_producer`) and no proposal. Every case is judged by it.
 * - {@link checkHatDensity}: the hats in the drum clip are at least 1.5 times
 *   as many, and every other pad's notes are as they were.
 * - {@link checkPointsToGenerate}: the reply mentions the Generate panel.
 * - {@link checkDevelopsTrack}: the arrangement runs 100 to 300 bars, every
 *   track drops out somewhere, and at least three different sets of tracks
 *   play over the song.
 * - {@link checkPadSound}: one new synth track with a slow attack and a long
 *   release, playing a sparse 4-bar clip placed on it.
 * - {@link checkDissonant}: a chord on the new synth track holds a minor 2nd,
 *   a major 7th or a tritone.
 */
import type { NoteEvent, Project, Track } from "../../domain/entities";
import {
  readInstrumentParameter,
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_RELEASE,
} from "../../domain/parameters";
import { TICKS_PER_BAR } from "../../domain/time";
import type { CheckResult } from "./checks";

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

/** What a case expects the turn to come back with. */
export type EvalExpectation = "proposal" | "ask";

/** The checks a case may name beside the shared ones. */
export const CASE_CHECK_IDS = [
  "hatDensity",
  "pointsToGenerate",
  "developsTrack",
  "padSound",
  "dissonant",
] as const;
export type CaseCheckId = (typeof CASE_CHECK_IDS)[number];

// ---------------------------------------------------------------------------
// Expected outcome
// ---------------------------------------------------------------------------

/** What of a turn {@link checkOutcome} reads. */
export interface OutcomeTurn {
  readonly proposal: unknown;
  readonly ask?: { readonly question: string } | null;
}

/**
 * `ask` passes when the turn asked the producer a question and proposed
 * nothing; `proposal` passes when it proposed something, and fails a turn
 * that only asked.
 */
export function checkOutcome(expect: EvalExpectation, turn: OutcomeTurn): CheckResult {
  const proposed = turn.proposal !== null && turn.proposal !== undefined;
  const asked = turn.ask ? `"${turn.ask.question}"` : null;
  if (expect === "ask") {
    if (proposed) return fail("Proposed a change instead of asking first");
    return asked ? pass(`Asked ${asked}`) : fail("Neither asked a question nor proposed");
  }
  if (proposed) return pass("Proposed a change");
  return fail(asked ? `Only asked ${asked}` : "Proposed nothing");
}

// ---------------------------------------------------------------------------
// Hat density
// ---------------------------------------------------------------------------

/** "hat" at the start of a word: "Closed Hat", "Hats", not "Chat". */
const HAT = /\bhat/i;

/** The IDs of every drum pad in `project` whose name says it is a hat. */
function hatPadIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const track of project.song.tracks) {
    if (track.instrument?.kind !== "drumMachine") continue;
    for (const pad of track.instrument.pads) if (HAT.test(pad.name)) ids.add(pad.id);
  }
  return ids;
}

function padOf(event: NoteEvent): string | null {
  return event.trigger.kind === "pad" ? event.trigger.padId : null;
}

/** A note as it sounds, without the ID a rewrite would change. */
function noteKey(event: NoteEvent): string {
  return JSON.stringify([
    event.trigger,
    event.startTicks,
    event.durationTicks,
    event.velocity,
    event.probability,
  ]);
}

function sortedKeys(events: readonly NoteEvent[]): string {
  return JSON.stringify(events.map(noteKey).sort());
}

/**
 * The clips in `before` that play hats now hold at least `factor` times as
 * many hat notes (every pad named "hat" counts, closed and open), and every
 * other pad's notes in them are unchanged, compared as they sound rather than
 * by ID, so clearing and rewriting a clip is fine.
 */
export function checkHatDensity(
  before: Project,
  after: Project,
  factor = 1.5,
): CheckResult {
  const hats = hatPadIds(before);
  const isHat = (event: NoteEvent) => hats.has(padOf(event) ?? "");
  const clips = before.clips.filter(
    (clip) => clip.content.kind === "notes" && clip.content.events.some(isHat),
  );
  if (clips.length === 0) return fail("The fixture has no clip with hats");
  let hatsBefore = 0;
  let hatsAfter = 0;
  const changedOthers: string[] = [];
  for (const clip of clips) {
    const was = clip.content.kind === "notes" ? clip.content.events : [];
    const now = after.clips.find((candidate) => candidate.id === clip.id);
    if (!now || now.content.kind !== "notes") {
      return fail(`Removed the clip "${clip.name}"`);
    }
    hatsBefore += was.filter(isHat).length;
    hatsAfter += now.content.events.filter(isHat).length;
    const others = (events: readonly NoteEvent[]) =>
      sortedKeys(events.filter((event) => !isHat(event)));
    if (others(was) !== others(now.content.events)) changedOthers.push(clip.name);
  }
  if (changedOthers.length > 0) {
    return fail(`Changes notes other than the hats in "${changedOthers.join('", "')}"`);
  }
  const ratio = hatsAfter / hatsBefore;
  const counts = `${hatsBefore} hat notes became ${hatsAfter}`;
  return ratio >= factor
    ? pass(`${counts} (${ratio.toFixed(2)}x)`)
    : fail(`${counts} (${ratio.toFixed(2)}x, needs ${factor}x)`);
}

// ---------------------------------------------------------------------------
// Points to the Generate panel
// ---------------------------------------------------------------------------

/** "generate" and "panel" within a few words of each other, either way round. */
const GENERATE_PANEL =
  /generat\w*\W+(?:\w+\W+){0,4}?panel|panel\W+(?:\w+\W+){0,4}?generat/i;

/** The reply points the producer at the Generate panel. */
export function checkPointsToGenerate(text: string): CheckResult {
  return GENERATE_PANEL.test(text)
    ? pass("Mentions the Generate panel")
    : fail("Does not mention the Generate panel");
}

// ---------------------------------------------------------------------------
// Develops the loop into a track
// ---------------------------------------------------------------------------

export interface DevelopsTrackLimits {
  readonly minBars: number;
  readonly maxBars: number;
  /** The fewest different sets of playing tracks across the song. */
  readonly minCombinations: number;
}

export const DEVELOPS_TRACK_LIMITS: DevelopsTrackLimits = {
  minBars: 100,
  maxBars: 300,
  minCombinations: 3,
};

/** The song's length in bars: up to the end of its last placement. */
export function arrangementBars(project: Project): number {
  const end = Math.max(
    0,
    ...project.song.placements.map(
      (placement) => placement.startTicks + placement.durationTicks,
    ),
  );
  return Math.ceil(end / TICKS_PER_BAR);
}

/** For each bar, the IDs of the tracks with a placement playing in it. */
function activeTracksByBar(project: Project, bars: number): Set<string>[] {
  const active = Array.from({ length: bars }, () => new Set<string>());
  for (const placement of project.song.placements) {
    const first = Math.floor(placement.startTicks / TICKS_PER_BAR);
    const end = Math.ceil(
      (placement.startTicks + placement.durationTicks) / TICKS_PER_BAR,
    );
    for (let bar = first; bar < Math.min(end, bars); bar += 1) {
      active[bar].add(placement.trackId);
    }
  }
  return active;
}

/**
 * The loop became a track: it runs between `minBars` and `maxBars`, every
 * track is silent for at least one bar somewhere in it, and at least
 * `minCombinations` different sets of tracks play over its bars. A bar where
 * nothing plays is not a set of tracks, so a silent gap does not count.
 */
export function checkDevelopsTrack(
  after: Project,
  limits: DevelopsTrackLimits = DEVELOPS_TRACK_LIMITS,
): CheckResult {
  const bars = arrangementBars(after);
  const problems: string[] = [];
  if (bars < limits.minBars || bars > limits.maxBars) {
    problems.push(`${bars} bars long, not ${limits.minBars} to ${limits.maxBars}`);
  }
  const active = activeTracksByBar(after, bars);
  const always = after.song.tracks.filter((track) =>
    active.every((playing) => playing.has(track.id)),
  );
  if (always.length > 0) {
    problems.push(
      `never drops out: ${always.map((track: Track) => track.name).join(", ")}`,
    );
  }
  const combinations = new Set(
    active
      .filter((playing) => playing.size > 0)
      .map((playing) => [...playing].sort().join(",")),
  );
  if (combinations.size < limits.minCombinations) {
    problems.push(
      `${combinations.size} different sets of tracks play, needs ${limits.minCombinations}`,
    );
  }
  return problems.length > 0
    ? fail(problems.join("; "))
    : pass(
        `${bars} bars; every track drops out; ${combinations.size} different sets of tracks`,
      );
}

// ---------------------------------------------------------------------------
// A pad sound, and a dissonant one
// ---------------------------------------------------------------------------

export interface PadSoundLimits {
  readonly minAttackSeconds: number;
  readonly minReleaseSeconds: number;
  readonly clipBars: number;
  /** The most distinct note start times the clip may have. */
  readonly maxNoteStarts: number;
}

export const PAD_SOUND_LIMITS: PadSoundLimits = {
  minAttackSeconds: 0.5,
  minReleaseSeconds: 1,
  clipBars: 4,
  maxNoteStarts: 8,
};

function newSynthTracks(before: Project, after: Project): Track[] {
  const existing = new Set<string>(before.song.tracks.map((track) => track.id));
  return after.song.tracks.filter(
    (track) => !existing.has(track.id) && track.instrument?.kind === "synth",
  );
}

function noteClipsOn(project: Project, trackId: string) {
  return project.clips.flatMap((clip) =>
    clip.trackId === trackId && clip.content.kind === "notes"
      ? [{ clip, events: clip.content.events }]
      : [],
  );
}

/**
 * The proposal adds exactly one track, a synth, whose amp envelope has an
 * attack and a release at least as long as the limits, with a clip of
 * `clipBars` bars whose notes start at no more than `maxNoteStarts` times,
 * placed on that track: a clip nothing places is silent.
 */
export function checkPadSound(
  before: Project,
  after: Project,
  limits: PadSoundLimits = PAD_SOUND_LIMITS,
): CheckResult {
  const added = after.song.tracks.length - before.song.tracks.length;
  const synths = newSynthTracks(before, after);
  if (added !== 1 || synths.length !== 1) {
    return fail(`Adds ${added} tracks, ${synths.length} of them synths: needs one synth`);
  }
  const [track] = synths;
  const parameters = track.instrument?.parameters ?? {};
  const attack = readInstrumentParameter(SYNTH_AMP_ATTACK, parameters);
  const release = readInstrumentParameter(SYNTH_AMP_RELEASE, parameters);
  const problems: string[] = [];
  if (attack < limits.minAttackSeconds) {
    problems.push(`attack ${attack} s, needs ${limits.minAttackSeconds} s`);
  }
  if (release < limits.minReleaseSeconds) {
    problems.push(`release ${release} s, needs ${limits.minReleaseSeconds} s`);
  }
  const placed = new Set<string>(
    after.song.placements
      .filter((placement) => placement.trackId === track.id)
      .map((placement) => placement.clipId),
  );
  const clips = noteClipsOn(after, track.id);
  const fitting = clips.filter(
    ({ clip }) => clip.lengthTicks === limits.clipBars * TICKS_PER_BAR,
  );
  const placedFitting = fitting.filter(({ clip }) => placed.has(clip.id));
  if (fitting.length === 0) {
    problems.push(`no ${limits.clipBars}-bar clip`);
  } else {
    const sparse = placedFitting.find(
      ({ events }) =>
        events.length > 0 &&
        new Set(events.map((event) => event.startTicks)).size <= limits.maxNoteStarts,
    );
    if (!sparse) {
      problems.push(
        placedFitting.length === 0
          ? `its ${limits.clipBars}-bar clip is not placed on it`
          : `no placed ${limits.clipBars}-bar clip with 1 to ${limits.maxNoteStarts} note starts`,
      );
    }
  }
  return problems.length > 0
    ? fail(`"${track.name}": ${problems.join("; ")}`)
    : pass(
        `"${track.name}": attack ${attack} s, release ${release} s, a sparse ${limits.clipBars}-bar clip`,
      );
}

/**
 * Semitones apart, folded into an octave: minor 2nd, tritone, major 7th.
 * Compound intervals count as the interval they fold to, so a minor 9th is a
 * minor 2nd and a major 14th a major 7th: they clash the same way.
 */
const DISSONANT_INTERVALS: ReadonlyMap<number, string> = new Map([
  [1, "minor 2nd"],
  [6, "tritone"],
  [11, "major 7th"],
]);

/** The pitches sounding at each moment a note starts, where there are two or more. */
function chords(events: readonly NoteEvent[]): number[][] {
  const pitched = events.flatMap((event) =>
    event.trigger.kind === "pitch" ? [{ ...event, pitch: event.trigger.pitch }] : [],
  );
  const starts = [...new Set(pitched.map((event) => event.startTicks))];
  return starts
    .map((tick) =>
      pitched
        .filter(
          (event) =>
            event.startTicks <= tick && tick < event.startTicks + event.durationTicks,
        )
        .map((event) => event.pitch),
    )
    .filter((pitches) => new Set(pitches).size >= 2);
}

/** The dissonant interval in `pitches`, if any. */
function dissonance(pitches: readonly number[]): string | null {
  for (const low of pitches) {
    for (const high of pitches) {
      if (high <= low) continue;
      const name = DISSONANT_INTERVALS.get((high - low) % 12);
      if (name) return name;
    }
  }
  return null;
}

/**
 * At least one chord on a new synth track holds a minor 2nd, a major 7th or a
 * tritone, compound intervals included (a minor 9th counts as a minor 2nd):
 * notes sounding together when one of them starts.
 */
export function checkDissonant(before: Project, after: Project): CheckResult {
  const tracks = newSynthTracks(before, after);
  if (tracks.length === 0) return fail("Adds no synth track");
  let chordCount = 0;
  for (const track of tracks) {
    for (const { events } of noteClipsOn(after, track.id)) {
      for (const chord of chords(events)) {
        chordCount += 1;
        const interval = dissonance(chord);
        if (interval) return pass(`A chord on "${track.name}" holds a ${interval}`);
      }
    }
  }
  return fail(
    chordCount === 0
      ? "The new synth plays no chords"
      : `None of its ${chordCount} chords holds a minor 2nd, major 7th or tritone`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Runs the case check `id` on an applied proposal. */
export function runCaseCheck(
  id: CaseCheckId,
  before: Project,
  after: Project,
  text: string,
): CheckResult {
  switch (id) {
    case "hatDensity":
      return checkHatDensity(before, after);
    case "pointsToGenerate":
      return checkPointsToGenerate(text);
    case "developsTrack":
      return checkDevelopsTrack(after);
    case "padSound":
      return checkPadSound(before, after);
    case "dissonant":
      return checkDissonant(before, after);
  }
}
