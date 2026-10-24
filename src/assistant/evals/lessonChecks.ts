/**
 * GRV-208: the checks on Coproducer's lesson turns, each from a QA finding of
 * GRV-43 and GRV-44. Code checks, like every other, with no LLM judge: each is
 * a pure function of the reply (its text, its calls, its question) and what
 * the turn sent (the lesson block, the producer's message, the project
 * description), so a saved report replays against them.
 *
 * 24. {@link checkStartsLesson}: a request for a lesson gets exactly the named
 *     `start_lesson` call, no other call beside it (a song change, a memory,
 *     an explanation, a recommendation) and no question instead.
 * 25. {@link checkSaysOnlyChanges}: every number, pitch name, pitch range, key,
 *     above/below claim and track name in the reply is in what the turn sent:
 *     the lesson's `changes`, its step, the rest of its block, the producer's
 *     message or the project description (which track sits above which is
 *     read off the registers it sends). A key the reply says was set must
 *     be in `changes` (the step is what is still to do).
 * 26. {@link checkNamesOnlyBlockBites}: every bite or chapter the reply names
 *     is one the block names (`bite`, `next`, `earlier`, `passed`), and a
 *     wrap-up (`chapter_done`, `track_done`) offers two or three of `next`
 *     (its one, when it has one).
 * 27. {@link checkAsksThroughTool}: a question goes through `ask_producer`, and
 *     the text holds no bracketed transcript or option list; a quiz has two
 *     to four options; a wrap-up asks nothing, by the tool or in text, and
 *     sets no quiz.
 * 28. {@link checkNoHistoryNote}: no bracketed note of the kind the history
 *     writes (`history.ts`, `ask.ts`) is echoed in the reply.
 *
 * 25 to 28 judge every turn of a lesson session (`lessonSession.ts`), each
 * against what that turn sent; 24 judges the cases that ask for a lesson.
 */
import type { Project } from "../../domain/entities";
import { ALL_BITES, CHAPTERS } from "../../lessons/chapters";
import type { LessonChoice } from "../../lessons/ids";
import { TRACK_TITLE } from "../../lessons/track";
import { ASK_PRODUCER_TOOL_NAME } from "../ask";
import type { AssistantLessonContext } from "../lesson";
import { isLessonCall, parseLessonCall } from "../lessonTool";
import { REMEMBER_TOOL_NAME } from "../memory";
import { buildAssistantPayload } from "../payload";
import type { AssistantToolCall } from "../protocol";
import { RECOMMEND_SOUNDS_TOOL } from "../recommendation";
import { EXPLAIN_TOOL_NAME } from "../tools";
import { RECOMMEND_VIDEO_TOOL } from "../video";
import type { CheckResult } from "./checks";

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

/** The lesson checks, in their numbered order. */
export const LESSON_CHECK_IDS = [
  "startsLesson",
  "saysOnlyChanges",
  "namesOnlyBlockBites",
  "asksThroughTool",
  "noHistoryNote",
] as const;
export type LessonCheckId = (typeof LESSON_CHECK_IDS)[number];

/**
 * The lesson checks judged on every turn of a lesson session, which an
 * experiment may hold on every turn (`everyTurnChecks`).
 */
export const LESSON_TURN_CHECKS = [
  "saysOnlyChanges",
  "namesOnlyBlockBites",
  "asksThroughTool",
  "noHistoryNote",
] as const satisfies readonly LessonCheckId[];
export type LessonTurnCheckId = (typeof LESSON_TURN_CHECKS)[number];

export function isLessonCheck(id: string): id is LessonCheckId {
  return (LESSON_CHECK_IDS as readonly string[]).includes(id);
}

export function isLessonTurnCheck(id: string): id is LessonTurnCheckId {
  return (LESSON_TURN_CHECKS as readonly string[]).includes(id);
}

/** What of a turn's reply the lesson checks read. */
export interface LessonReply {
  readonly text: string;
  readonly proposal?: { readonly calls: readonly AssistantToolCall[] } | null;
  readonly ask?: {
    readonly question: string;
    readonly options: readonly { readonly label: string }[];
  } | null;
}

/** What one turn sent, which the reply is held to. */
export interface LessonTurnSent {
  /** The lesson block, or null for a turn outside a lesson. */
  readonly lesson: AssistantLessonContext | null;
  /** The producer's message, as the turn sent it. */
  readonly request: string;
  /** The project description's facts, from {@link describedFacts}. */
  readonly described: string;
}

/** Calls that change nothing in the song: what the panel takes out before it. */
const NOT_SONG_CHANGES: ReadonlySet<string> = new Set([
  EXPLAIN_TOOL_NAME,
  "start_lesson",
  REMEMBER_TOOL_NAME,
  RECOMMEND_SOUNDS_TOOL,
  RECOMMEND_VIDEO_TOOL,
]);

/** The calls of a proposal that change the song. */
export function songChangeCalls(
  proposal: LessonReply["proposal"],
): readonly AssistantToolCall[] {
  return (proposal?.calls ?? []).filter((call) => !NOT_SONG_CHANGES.has(call.name));
}

// ---------------------------------------------------------------------------
// 24. Starts the lesson asked for
// ---------------------------------------------------------------------------

export function checkStartsLesson(
  expected: LessonChoice,
  reply: LessonReply,
): CheckResult {
  const calls = reply.proposal?.calls ?? [];
  const lessons = calls.filter(isLessonCall);
  // "Nothing else proposed": not a song change, and not a memory, an
  // explanation or a recommendation riding along either.
  const others = calls.filter((call) => !isLessonCall(call));
  if (lessons.length === 0) {
    return fail(
      reply.ask
        ? `Asked "${reply.ask.question}" instead of calling start_lesson`
        : "Called no start_lesson",
    );
  }
  if (lessons.length > 1) return fail(`Called start_lesson ${lessons.length} times`);
  const chapter = parseLessonCall(lessons[0] as AssistantToolCall);
  if (chapter !== expected) {
    return fail(`Started "${chapter ?? "an invalid chapter"}", not "${expected}"`);
  }
  if (others.length > 0) {
    const changes = new Set(songChangeCalls(reply.proposal));
    const names = others.map((call) => call.name).join(", ");
    return fail(
      others.some((call) => changes.has(call))
        ? `Changed the song beside it: ${names}`
        : `Proposed something beside it: ${names}`,
    );
  }
  if (reply.ask) return fail(`Also asked "${reply.ask.question}"`);
  return pass(`One start_lesson("${expected}"), nothing else`);
}

// ---------------------------------------------------------------------------
// The project description's facts (check 25)
// ---------------------------------------------------------------------------

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** A MIDI pitch as a name with its octave, C4 being middle C: 57 is "A3". */
export function pitchName(pitch: number): string {
  return `${PITCH_CLASSES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/**
 * The facts of the project description a turn sends (`payload.ts`) that a
 * reply may restate, as text: the tempo and metre, the song's length in bars,
 * each track's name, pads, note count, register (as pitch names) and the
 * bars its placements cover, and the sections. Not the IDs, ticks, volumes
 * or statistics, which no lesson reply has reason to quote and whose numbers
 * would let any figure through.
 */
export function describedFacts(project: Project): string {
  const context = buildAssistantPayload(project);
  const ticksPerBar =
    (project.song.timeSignature.numerator * 4 * 192) /
    project.song.timeSignature.denominator;
  const bars = (ticks: number) => Math.round(ticks / ticksPerBar);
  const lines = [
    `${context.tempo} BPM`,
    `${context.timeSignature.numerator}/${context.timeSignature.denominator}`,
    `${bars(context.totalTicks)} bars`,
    `${context.tracks.length} tracks`,
  ];
  for (const track of context.tracks) {
    const stats = context.noteStats.tracks.find((entry) => entry.trackId === track.id);
    const register = stats?.register
      ? ` from ${pitchName(stats.register.lowestPitch)} to ${pitchName(stats.register.highestPitch)}`
      : "";
    const placed = track.placements
      .map(
        (placement) =>
          `bars ${bars(placement.startTicks) + 1}-${bars(placement.startTicks + placement.durationTicks)}`,
      )
      .join(", ");
    const pads = track.pads.map((pad) => pad.name).join(", ");
    lines.push(
      `${track.name} track: ${stats?.noteCount ?? 0} notes${register}; ${placed}${pads ? `; pads ${pads}` : ""}`,
    );
  }
  for (const section of context.sections) {
    lines.push(
      `${section.name}: bars ${bars(section.startTicks) + 1}-${bars(section.startTicks + section.durationTicks)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 25. Says only what changes says
// ---------------------------------------------------------------------------

/** Every changes line the turn sent: the moment's and those it waited with. */
function changeLines(lesson: AssistantLessonContext | null): string[] {
  if (!lesson) return [];
  return [...lesson.changes, ...lesson.earlier.flatMap((entry) => entry.changes)];
}

/** Everything the turn sent that a reply may restate, as one text. */
function sourceText(sent: LessonTurnSent): string {
  const lesson = sent.lesson;
  const block = lesson
    ? [
        lesson.chapter,
        lesson.bite,
        lesson.skill,
        lesson.step ?? "",
        lesson.style?.replace(/_/g, " ") ?? "",
        lesson.quiz ?? "",
        ...lesson.next,
        ...lesson.passed,
        ...lesson.earlier.flatMap((entry) => [entry.chapter, entry.bite]),
        lesson.track
          ? `${lesson.track.title} chapter ${lesson.track.chapterNumber} of ${lesson.track.chapterCount}`
          : "",
      ]
    : [];
  return [...changeLines(lesson), ...block, sent.request, sent.described].join("\n");
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  sixteen: 16,
  "thirty-two": 32,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
};

/**
 * Words with a number in them that name a thing rather than count one:
 * note values ("16th notes", "eighth-note hats"), drum machines ("808"),
 * a metre ("4/4"). Taken out before the numbers are read.
 */
const NOT_A_FIGURE =
  /\b(?:(?:1\/)?(?:4|8|16|32)(?:th|nd)?s?|quarter|eighth|sixteenth|thirty-second)[- ](?:notes?|hats?|hi-hats?|steps?|grid|rolls?)\b|\b(?:4|8|16|32)ths\b|\b(?:TR-)?(?:808|909|303|606)s?\b|\b\d+\/\d+\b/gi;

/** `text` without what has a number in it but is no figure: note values, drum machines, pitches. */
function withoutNonFigures(text: string): string {
  return text.replace(NOT_A_FIGURE, " ").replace(PITCH, " ");
}

/**
 * "One" and "first" as a figure: only beside a unit of the music ("one chord
 * per bar", "the first bar", "one note"), never in "this one", "one of" or
 * "first, ...", which count nothing.
 */
const ONE_AS_FIGURE =
  /\b(one|first)\s+(?:(?:chords?|notes?|triads?|hits?|hats?|kicks?|snares?|claps?)\s+)?(?:(?:per|a|each|every)\s+)?(?:bars?|beats?|steps?|chords?|notes?|triads?|hits?|hats?|kicks?|snares?|claps?)\b/gi;

/** The numbers in a text, each with where it was said: digits, number words, ordinals. */
function numbersSaid(text: string): { value: number; said: string }[] {
  const plain = withoutNonFigures(text);
  const said: { value: number; said: string }[] = [];
  for (const match of plain.matchAll(/\d+(?:\.\d+)?/g)) {
    said.push({ value: Number(match[0]), said: match[0] });
  }
  for (const match of plain.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)?\b/g)) {
    const value = NUMBER_WORDS[match[0].toLowerCase()];
    if (value !== undefined) said.push({ value, said: match[0] });
  }
  for (const match of plain.matchAll(ONE_AS_FIGURE)) {
    said.push({ value: 1, said: match[0] });
  }
  return said;
}

/** The numbers a text gives, in digits or words, ordinals included. */
function numbersIn(text: string): Set<number> {
  return new Set(numbersSaid(text).map(({ value }) => value));
}

const SEMITONES: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const PITCH = /\b([A-G])([#♯b♭]?)(-?\d)\b/g;

/** Every pitch name with an octave in `text`, spelled with sharps: "Bb3" is "A#3". */
function pitchesIn(text: string): string[] {
  return [...text.matchAll(PITCH)].map((match) => {
    const accidental = match[2] === "#" || match[2] === "♯" ? 1 : match[2] ? -1 : 0;
    const octave = Number(match[3]);
    return pitchName(SEMITONES[match[1] as string] + accidental + (octave + 1) * 12);
  });
}

/** A key, "A minor" or "Am", spelled one way: "a minor". */
const KEY_LONG = /\b([A-G])([#♯b♭]?)\s+(major|minor)\b/g;
const KEY_SHORT = /\b([A-G])([#♯b♭]?)(m)\b/g;

function keySpelling(root: string, accidental: string, scale: string): string {
  const mark = accidental === "#" || accidental === "♯" ? "#" : accidental ? "b" : "";
  return `${root.toLowerCase()}${mark} ${scale === "m" ? "minor" : scale.toLowerCase()}`;
}

function keysIn(text: string): string[] {
  return [
    ...[...text.matchAll(KEY_LONG)].map((m) =>
      keySpelling(m[1] as string, m[2] as string, m[3] as string),
    ),
    ...[...text.matchAll(KEY_SHORT)].map((m) =>
      keySpelling(m[1] as string, m[2] as string, "m"),
    ),
  ];
}

/** A key named: "A minor", "Am". */
const A_KEY = String.raw`[A-G][#♯b♭]?(?:\s+(?:major|minor)|m\b)`;

/**
 * What says a key was set, each the clause's verb on: a verb that sets with
 * the key, or the song, track or it set to a key, after it ("set the key to
 * A minor", "set the song to A minor", "put it in Am"); the key, song or
 * track said to be set ("the song is set to A minor", "the key has been
 * changed"); or the song said to be in a key now ("your song is in A minor
 * now", "it's now in Am").
 */
const KEY_SET_CLAIMS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(set|picked|pick|chose|chosen|choose|changed|change|switched|switch|put|moved|move)\b(?:[^.!?;]*\b[Kk]ey\b|\s+(?:the\s+|your\s+)?(?:song|track|project|beat|it|everything)\s+(?:to|in|into)\s+${A_KEY}|\s+(?:to|in|into)\s+${A_KEY})`,
    "g",
  ),
  /\b(?:[Kk]ey|song|track|project|it|everything)(?:'s|\s+is|\s+was|\s+has been|\s+got|\s+now)\s+(?:now\s+|also\s+|just\s+)?(?:set|put|changed|switched)\b/g,
  /\b[Kk]ey\b[^.!?;]*\b(?:is now|was set|has been set|now set|is set|got set)\b/g,
  new RegExp(
    String.raw`\b(?:song|track|project|it|everything|beat)(?:'s|\s+is|\s+are)\s+(?:now\s+)?in\s+${A_KEY}(?:\s+now)?|\bnow in\s+${A_KEY}|\bin\s+${A_KEY}\s+now\b`,
    "g",
  ),
];

/** Words before a verb that make it something still to do, or only possible. */
const NOT_DONE =
  /\b(?:can|could|will|'ll|would|should|need to|needs to|want to|let's|next|to do|try|if|once|when|until|before)\b/i;

/** A verb that tells the producer to do it, when nothing comes before it in its clause. */
const IMPERATIVE = /^(?:set|pick|choose|change|switch|put|move)$/;

/**
 * Whether `sentence` says the key has been set: a claim whose own clause,
 * up to the verb (from the last comma, colon, semicolon or dash), neither
 * holds a word of something still to do ("you can set", "once you've set")
 * nor is empty before a bare verb, which is an instruction ("Next, set the
 * key to A minor"). A "will" later in the sentence ("so the bass will
 * agree") excuses nothing.
 */
function claimsKeySet(said: string): boolean {
  // Case-sensitive, so "a minor" is no key; only the sentence's first word
  // is capitalized for grammar's sake.
  const sentence = said.charAt(0).toLowerCase() + said.slice(1);
  for (const pattern of KEY_SET_CLAIMS) {
    for (const match of sentence.matchAll(pattern)) {
      const start = match.index ?? 0;
      const before =
        sentence
          .slice(0, start)
          .split(/[,;:—–(]/)
          .pop() ?? "";
      if (NOT_DONE.test(before)) continue;
      if (before.trim() === "" && match[1] && IMPERATIVE.test(match[1])) continue;
      return true;
    }
  }
  return false;
}

/** A part a pitch claim can sit above or below. */
const PARTS = new Set([
  "kick",
  "kicks",
  "snare",
  "clap",
  "hats",
  "hat",
  "bass",
  "bassline",
  "chords",
  "chord",
  "hook",
  "melody",
  "beat",
  "drums",
  "pad",
  "lead",
  "pluck",
]);

const RELATION =
  /\b(above|below|under|underneath|beneath|over|higher than|lower than|on top of)\s+(?:the\s+|your\s+|its\s+)?([A-Za-z][\w'-]*)/gi;

/** "above the chords", spelled one way: "above chords", with where it was said. */
function relationsIn(
  text: string,
  parts: ReadonlySet<string>,
): { claim: string; relation: string; part: string; index: number }[] {
  return [...text.matchAll(RELATION)]
    .filter((match) => parts.has((match[2] as string).toLowerCase()))
    .map((match) => {
      const relation = (match[1] as string).toLowerCase();
      const part = (match[2] as string).toLowerCase();
      return { claim: `${relation} ${part}`, relation, part, index: match.index ?? 0 };
    });
}

const UP = new Set(["above", "over", "on top of", "higher than"]);
const DOWN = new Set(["below", "under", "underneath", "beneath", "lower than"]);

/** A track's register, as the description sends it. */
interface Register {
  readonly low: number;
  readonly high: number;
}

/** Each track's register in `described` ("Hook track: 8 notes from A4 to F5"), by lower-case name. */
function registersIn(described: string): ReadonlyMap<string, Register> {
  const registers = new Map<string, Register>();
  for (const match of described.matchAll(
    /^(.+) track: \d+ notes from ([A-G]#?-?\d) to ([A-G]#?-?\d)/gm,
  )) {
    const [low, high] = [
      pitchesIn(match[2] as string)[0],
      pitchesIn(match[3] as string)[0],
    ];
    if (low && high) {
      registers.set((match[1] as string).toLowerCase(), {
        low: pitchNumber(low),
        high: pitchNumber(high),
      });
    }
  }
  return registers;
}

/** "A3" back to 57. */
function pitchNumber(name: string): number {
  const match = name.match(/^([A-G]#?)(-?\d+)$/);
  return PITCH_CLASSES.indexOf(match?.[1] as string) + (Number(match?.[2]) + 1) * 12;
}

/**
 * Whether the registers say `upper` sits above `lower`: it starts no lower
 * and reaches higher. A hook at A4-F5 is above chords at A3-D5; one at
 * A3-F4 is not.
 */
function sitsAbove(upper: Register, lower: Register): boolean {
  return upper.low >= lower.low && upper.high > lower.high;
}

/**
 * The above/below claims of `text` that nothing the turn sent backs. A claim
 * between two tracks the description gives registers for ("the hook sits
 * above the chords", its subject the last such track before it in its
 * sentence) is judged on those registers alone, so the step's "above the
 * chords" (still to do) cannot back a hook Show me wrote under them. A
 * claim with no such subject ("just above the chords") is backed by the
 * same words in a source, or by any track the registers put there.
 */
function unsentRelations(
  text: string,
  sources: string,
  parts: ReadonlySet<string>,
  registers: ReadonlyMap<string, Register>,
): string[] {
  const known = new Set(relationsIn(sources, parts).map((each) => each.claim));
  const strays: string[] = [];
  for (const sentence of sentencesOf(text)) {
    for (const { claim, relation, part, index } of relationsIn(sentence, parts)) {
      const up = UP.has(relation);
      if (!up && !DOWN.has(relation)) continue;
      const object = registers.get(part);
      const subjectName = (sentence.slice(0, index).match(/[A-Za-z][\w'-]*/g) ?? [])
        .map((word) => word.toLowerCase())
        .filter((word) => word !== part && registers.has(word))
        .at(-1);
      const subject = subjectName ? registers.get(subjectName) : undefined;
      const holds = (s: Register, o: Register) =>
        up ? sitsAbove(s, o) : sitsAbove(o, s);
      if (object && subject) {
        if (!holds(subject, object)) strays.push(`${subjectName} ${claim}`);
        continue;
      }
      const backed =
        known.has(claim) ||
        (object !== undefined &&
          [...registers].some(([name, each]) => name !== part && holds(each, object)));
      if (!backed) strays.push(claim);
    }
  }
  return strays;
}

/** A name before "track": "the Melody track", "your Bass track". */
const TRACK_NAME = /\b([A-Z][\w'#-]*(?:\s+[A-Z][\w'#-]*)?)\s+track\b/g;
const NOT_A_NAME = new Set([
  "the",
  "a",
  "an",
  "your",
  "this",
  "that",
  "each",
  "every",
  "new",
  "one",
  "synth",
  "drum",
  "audio",
]);

function sentencesOf(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * 25: every figure in the reply is in what the turn sent. Numbers (digits or
 * words), pitch names, keys, "above/below the <part>" and "<Name> track" are
 * read from the reply and looked for in the sources; and a sentence that
 * says the key has been set passes only when a changes line says it was.
 */
export function checkSaysOnlyChanges(text: string, sent: LessonTurnSent): CheckResult {
  const sources = sourceText(sent);
  const problems: string[] = [];

  const known = numbersIn(sources);
  const strays = numbersSaid(text).filter(({ value }) => !known.has(value));
  if (strays.length > 0) {
    problems.push(
      `numbers not in what it was sent: ${[...new Set(strays.map((n) => n.said))].join(", ")}`,
    );
  }

  const knownPitches = new Set(pitchesIn(sources));
  const pitches = pitchesIn(text).filter((pitch) => !knownPitches.has(pitch));
  if (pitches.length > 0)
    problems.push(`pitches not in what it was sent: ${[...new Set(pitches)].join(", ")}`);

  const knownKeys = new Set(keysIn(sources));
  const keys = keysIn(text).filter((key) => !knownKeys.has(key));
  if (keys.length > 0)
    problems.push(`keys not in what it was sent: ${[...new Set(keys)].join(", ")}`);

  const keyChanged = changeLines(sent.lesson).some((line) => /^key\b/i.test(line));
  if (!keyChanged) {
    const claim = sentencesOf(text).find(claimsKeySet);
    if (claim) problems.push(`says the key was set, which no change says: "${claim}"`);
  }

  const trackNames = new Set(
    [...sent.described.matchAll(/^(.+) track:/gm)].map((m) =>
      (m[1] as string).toLowerCase(),
    ),
  );
  const parts = new Set([...PARTS, ...trackNames]);
  const relations = unsentRelations(text, sources, parts, registersIn(sent.described));
  if (relations.length > 0)
    problems.push(
      `claims not in what it was sent: ${[...new Set(relations)].join(", ")}`,
    );

  const names = [...text.matchAll(TRACK_NAME)]
    .map((m) => {
      const words = (m[1] as string).split(/\s+/);
      while (words.length > 0 && NOT_A_NAME.has((words[0] as string).toLowerCase())) {
        words.shift();
      }
      return words.join(" ");
    })
    // As the project names it: "melody" in the skill names no track.
    .filter((name) => name.length > 0 && !sources.includes(name));
  if (names.length > 0)
    problems.push(`tracks not in what it was sent: ${[...new Set(names)].join(", ")}`);

  return problems.length > 0
    ? fail(problems.join("; "))
    : pass("Every figure it gives is in what the turn sent");
}

// ---------------------------------------------------------------------------
// 26. Names only the block's bites
// ---------------------------------------------------------------------------

/** Every bite and chapter title there is. */
const TITLES: readonly string[] = [
  ...ALL_BITES.map((bite) => bite.title),
  ...CHAPTERS.map((chapter) => chapter.title),
  TRACK_TITLE,
];

const normalTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const KNOWN_TITLES = new Set(TITLES.map(normalTitle));

/** Starts of a phrase before "bite" or "chapter" that name no title. */
const NOT_A_TITLE = new Set([
  "the",
  "this",
  "that",
  "next",
  "each",
  "every",
  "your",
  "a",
  "an",
  "last",
  "first",
  "final",
  "one",
  "another",
  "whole",
  "new",
]);

/** The bites and chapters a reply names: quoted, or set beside "bite" or "chapter". */
export function namedTitles(text: string): string[] {
  const plain = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const named: string[] = [];
  // A quoted known title, or a quote beside "bite", "chapter" or "lesson".
  for (const match of plain.matchAll(/"([^"\n]{2,60})"/g)) {
    const quoted = match[1] as string;
    const index = match.index ?? 0;
    const around = plain.slice(Math.max(0, index - 20), index + match[0].length + 20);
    if (
      KNOWN_TITLES.has(normalTitle(quoted)) ||
      /\b(?:bite|chapter|lesson)\b/i.test(around)
    ) {
      named.push(quoted);
    }
  }
  // "the Sections bite", "the Bass chapter".
  for (const match of plain.matchAll(
    /\b((?:[A-Z][\w'-]*)(?:\s+(?:[a-z]{1,4}\s+)?[A-Z][\w'-]*)*)\s+(?:bite|chapter)\b/g,
  )) {
    const phrase = (match[1] as string).trim();
    const words = phrase.split(/\s+/);
    while (words.length > 0 && NOT_A_TITLE.has((words[0] as string).toLowerCase())) {
      words.shift();
    }
    if (words.length > 0) named.push(words.join(" "));
  }
  // "Next up: Sections", "next is Hats".
  for (const match of plain.matchAll(
    /\b[Nn]ext(?:\s+up)?(?:\s+(?:bite|chapter))?(?:\s+is|:|,|\s+comes)\s+"?([A-Z][^.,;:!?"\n]{1,50})/g,
  )) {
    const phrase = (match[1] as string).trim();
    if (
      !/^(?:chapter|bite)\b/i.test(phrase) &&
      !NOT_A_TITLE.has(phrase.split(/\s+/)[0]?.toLowerCase() ?? "")
    ) {
      named.push(phrase);
    }
  }
  // A known title of three words or more, as it is written.
  for (const title of TITLES) {
    if (title.split(/\s+/).length >= 3 && plain.includes(title)) named.push(title);
  }
  return named;
}

/**
 * 26: every bite or chapter the reply names is one the lesson block names,
 * as the bite, the chapter, in `next`, `passed` or `earlier`, or as "Finish
 * a track" when `track` is set. A turn outside a lesson has nothing to hold
 * it to.
 */
export function checkNamesOnlyBlockBites(
  text: string,
  lesson: AssistantLessonContext | null,
): CheckResult {
  if (!lesson) return pass("No lesson block");
  const allowed = new Set(
    [
      lesson.bite,
      lesson.chapter,
      ...lesson.passed,
      ...lesson.next,
      ...lesson.earlier.flatMap((entry) => [entry.bite, entry.chapter]),
      ...(lesson.track ? [lesson.track.title] : []),
    ].map(normalTitle),
  );
  const pointers = lesson.next.map(normalTitle);
  const strays = namedTitles(text).filter((name) => {
    const normal = normalTitle(name);
    return !allowed.has(normal) && !pointers.some((pointer) => pointer.includes(normal));
  });
  if (strays.length > 0) {
    return fail(
      `Names what the block does not: ${[...new Set(strays)].map((name) => `"${name}"`).join(", ")}`,
    );
  }
  if (isWrapUp(lesson)) {
    const offered = offeredPointers(text, lesson.next);
    const wanted = Math.min(2, lesson.next.length);
    if (offered.length < wanted) {
      return fail(
        `A wrap-up offering ${offered.length} of "next" as pointers, not ${wanted === 1 ? "its one" : "two or three"}`,
      );
    }
    return pass(
      `Names only the block's bites and chapters, and offers ${offered.length} of "next"`,
    );
  }
  return pass("Names only the block's bites and chapters");
}

/** A chapter's wrap-up, or the end of "Finish a track": no question, pointers from "next". */
function isWrapUp(lesson: AssistantLessonContext | null): boolean {
  return lesson?.moment === "chapter_done" || lesson?.moment === "track_done";
}

/** Words a pointer shares with any reply, which say nothing about which pointer it offers. */
const POINTER_FILLER = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "from",
  "with",
  "into",
  "through",
  "each",
  "your",
  "you",
  "it",
  "its",
  "them",
  "chapter",
  "lesson",
  "bite",
  "next",
  "start",
]);

/** The words of a phrase worth matching on, cut to a stem: "patterns" and "pattern" agree. */
function pointerWords(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [])
    .filter((word) => word.length >= 3 && !POINTER_FILLER.has(word))
    .map((word) => word.slice(0, 5));
}

/**
 * The pointers of `next` a reply offers. A pointer that quotes a lesson or
 * chapter (`The "Shape a sound" chapter: ...`, `Chapter 4 of "Finish a
 * track", "Arrange": ...`) is offered when the reply names its title, the
 * last one it quotes, and only then: its summary's words ("a beat, a bass")
 * are what any wrap-up talks about. Any other pointer is offered when the
 * reply shares two of its words (three, when it has five or more), as "roll
 * new hat patterns from the Generate panel" is by "roll a few hat patterns
 * in Generate".
 */
export function offeredPointers(text: string, next: readonly string[]): string[] {
  const reply = normalTitle(text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  const replyWords = new Set(pointerWords(text));
  return next.filter((pointer) => {
    const quoted = [...pointer.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    const title = quoted.at(-1);
    if (title) return new RegExp(`\\b${escapeRegExp(normalTitle(title))}\\b`).test(reply);
    const words = [...new Set(pointerWords(pointer))];
    const shared = words.filter((word) => replyWords.has(word)).length;
    return shared >= (words.length >= 5 ? 3 : 2);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// 27. Asks through the tool, never in text
// ---------------------------------------------------------------------------

/** The sentences of the reply that ask something, quotes taken out. */
function questionsIn(text: string): string[] {
  const plain = text.replace(/"[^"\n]*"|“[^”\n]*”/g, '""');
  return sentencesOf(plain).filter((sentence) => sentence.endsWith("?"));
}

/** The transcript the history writes for a question, or an answer to one. */
const ASK_TRANSCRIPT = /\[(?:I asked the producer|Answer to ")/i;

/** A quiz's options written out on one line: "A) It repeats B) It's loud". */
const INLINE_LETTERED = /(?:^|\s)\(?([A-D])\)\s*([^()\n]+?)(?=\s+\(?[A-D]\)|$)/gm;
/** A lettered option on its own line: "A. It repeats", "(b) It's loud". */
const LETTERED_LINE = /^\s*\(?[A-Da-d][).:]\s+(\S.*)$/;
/** A bulleted line: "- It repeats", "• It's loud". */
const BULLET_LINE = /^\s*(?:[-*•]|\d+[).])\s+(\S.*)$/;
/** A line that sets up a question: one ending in "?", or naming a quiz. */
const QUESTION_LEAD = /\?\s*$|\bquiz\b/i;

/**
 * The options a reply's text writes out as a quiz's: two or more lettered
 * ones ("A) ... B) ...", on a line or a line each), or the bulleted lines
 * right after a question or a quiz's lead-in. A bulleted explanation that
 * follows no question is not a quiz.
 */
function writtenOptions(text: string): string[] {
  const lines = text.split("\n");
  for (const line of lines) {
    const inline = [...line.matchAll(INLINE_LETTERED)].map((m) =>
      (m[2] as string).trim(),
    );
    if (inline.length >= 2) return inline;
  }
  const lettered = lines.flatMap((line) => {
    const match = line.match(LETTERED_LINE);
    return match ? [(match[1] as string).trim()] : [];
  });
  if (lettered.length >= 2) return lettered;
  for (let index = 0; index < lines.length; index += 1) {
    if (!QUESTION_LEAD.test(lines[index] as string)) continue;
    const bullets: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() === "" && bullets.length === 0) continue;
      const match = line.match(BULLET_LINE);
      if (!match) break;
      bullets.push((match[1] as string).trim());
    }
    if (bullets.length >= 2) return bullets;
  }
  return [];
}

/**
 * Whether the reply sets `quiz`: its question (the quiz up to its "?") in
 * the text, or a "quiz" offered ("Quick quiz:", "a pop quiz").
 */
function quizIn(text: string, quiz: string): boolean {
  const asked = normalTitle(quiz.split("?")[0] ?? "");
  return (
    (asked.length > 0 && normalTitle(text).includes(asked)) ||
    /\b(?:quick|pop|little|short)\s+quiz\b|\bquiz\s*:/i.test(text)
  );
}

/**
 * 27: a question in the reply goes through `ask_producer`: a reply whose text
 * asks something without the call fails, and so does one whose text writes
 * out the call's transcript, two or more of its options, or a quiz's
 * lettered or bulleted options. A quiz (a `bite_done` turn's question)
 * offers two to four options. A wrap-up (`chapter_done`, `track_done`) asks
 * nothing at all: no ask, no question in its text, no quiz.
 */
export function checkAsksThroughTool(
  reply: LessonReply,
  lesson: AssistantLessonContext | null,
): CheckResult {
  if (ASK_TRANSCRIPT.test(reply.text)) {
    return fail("Writes the question's transcript into its text");
  }
  const ask = reply.ask ?? null;
  const [question] = questionsIn(reply.text);
  if (isWrapUp(lesson)) {
    // `LESSON_RULES`: a wrap-up asks nothing, "No question, no quiz".
    if (ask) return fail(`Asks "${ask.question}" in a wrap-up, which asks nothing`);
    if (question) return fail(`Asks "${question}" in a wrap-up, which asks nothing`);
    if (lesson?.quiz && quizIn(reply.text, lesson.quiz)) {
      return fail("Sets the bite's quiz in a wrap-up, which asks nothing");
    }
  }
  if (!ask && question) {
    return fail(`Asks in its text without ask_producer: "${question}"`);
  }
  const options = writtenOptions(reply.text);
  if (options.length >= 2) {
    return fail(
      `Writes options out in its text: ${options.map((option) => `"${option}"`).join(", ")}`,
    );
  }
  if (!ask) return pass("Asked nothing");
  const lower = reply.text.toLowerCase();
  const written = ask.options.filter(
    (option) =>
      option.label.trim().length > 0 && lower.includes(option.label.trim().toLowerCase()),
  );
  if (written.length >= 2) {
    return fail(
      `Writes ${ask.options.length > written.length ? "some of " : ""}the options into its text: ${written.map((option) => `"${option.label}"`).join(", ")}`,
    );
  }
  if (
    lesson?.moment === "bite_done" &&
    (ask.options.length < 2 || ask.options.length > 4)
  ) {
    return fail(`Its quiz offers ${ask.options.length} options, not two to four`);
  }
  return pass(`Asked through ${ASK_PRODUCER_TOOL_NAME}: "${ask.question}"`);
}

// ---------------------------------------------------------------------------
// 28. No history note echoed
// ---------------------------------------------------------------------------

/** The openings of the bracketed notes the history writes (`history.ts`, `ask.ts`). */
const HISTORY_NOTE =
  /\[(?:I called |I asked the producer|I recommended |The producer (?:applied|cancelled|has not)|This proposal |Answer to ")[^\]\n]*\]?/i;

/** A line that is one bracketed note and nothing else. */
const BRACKETED_LINE = /^\s*\[[^\]\n]{8,}\]\s*$/m;

/** 28: no note the history writes, and no line in brackets of its kind, is in the reply. */
export function checkNoHistoryNote(text: string): CheckResult {
  const echoed = text.match(HISTORY_NOTE) ?? text.match(BRACKETED_LINE);
  return echoed
    ? fail(`Echoes a history note: "${echoed[0].trim().slice(0, 120)}"`)
    : pass("Echoes no history note");
}

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

/** Runs lesson check `id` on one turn's reply against what the turn sent. */
export function runLessonCheck(
  id: LessonCheckId,
  reply: LessonReply,
  sent: LessonTurnSent,
  startsLesson?: LessonChoice,
): CheckResult {
  switch (id) {
    case "startsLesson":
      return startsLesson
        ? checkStartsLesson(startsLesson, reply)
        : { status: "skip", detail: "The case asks for no lesson" };
    case "saysOnlyChanges":
      return checkSaysOnlyChanges(reply.text, sent);
    case "namesOnlyBlockBites":
      return checkNamesOnlyBlockBites(reply.text, sent.lesson);
    case "asksThroughTool":
      return checkAsksThroughTool(reply, sent.lesson);
    case "noHistoryNote":
      return checkNoHistoryNote(reply.text);
  }
}
