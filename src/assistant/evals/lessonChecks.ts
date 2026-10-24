/**
 * GRV-208: the checks on Coproducer's lesson turns, each from a QA finding of
 * GRV-43 and GRV-44. Code checks, like every other, with no LLM judge: each is
 * a pure function of the reply (its text, its calls, its question) and what
 * the turn sent (the lesson block, the producer's message, the project
 * description), so a saved report replays against them.
 *
 * 24. {@link checkStartsLesson}: a request for a lesson gets exactly the named
 *     `start_lesson` call, no song change beside it and no question instead.
 * 25. {@link checkSaysOnlyChanges}: every number, pitch name, pitch range, key,
 *     above/below claim and track name in the reply is in what the turn sent:
 *     the lesson's `changes`, its step, the rest of its block, the producer's
 *     message or the project description. A key the reply says was set must
 *     be in `changes` (the step is what is still to do).
 * 26. {@link checkNamesOnlyBlockBites}: every bite or chapter the reply names
 *     is one the block names (`bite`, `next`, `earlier`, `passed`).
 * 27. {@link checkAsksThroughTool}: a question goes through `ask_producer`, and
 *     the text holds no bracketed transcript or option list; a quiz has two
 *     to four options.
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
  const changes = songChangeCalls(reply.proposal);
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
  if (changes.length > 0) {
    return fail(
      `Changed the song beside it: ${changes.map((call) => call.name).join(", ")}`,
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

/** The numbers a text gives, in digits or words, ordinals included. */
function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  const plain = withoutNonFigures(text);
  for (const match of plain.matchAll(/\d+(?:\.\d+)?/g)) found.add(Number(match[0]));
  for (const match of plain.toLowerCase().matchAll(/\b[a-z]+(?:-[a-z]+)?\b/g)) {
    const value = NUMBER_WORDS[match[0]];
    if (value !== undefined) found.add(value);
  }
  return found;
}

/** The numbers in a reply's text, each with where it was said. */
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
  return said;
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

/** A sentence that says the key has been set, rather than that it is to be. */
const KEY_SET_CLAIM =
  /\b(?:(?:you|we|i|show me|it|that)(?:'ve| have| just| also| then)*\s+(?:\w+\s+){0,6}?(?:set|picked|chose|chosen|changed|switched|put)\b[^.!?]*\bkey\b|key\b[^.!?]*\b(?:is now|was set|has been set|now set|is set|got set)\b|\bnow in\s+[A-G][#♯b♭]?\s+(?:major|minor)\b)/i;
const NOT_DONE =
  /\b(?:can|could|will|'ll|should|need to|want to|let's|next|to do|try)\b/i;

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

/** "above the chords", spelled one way: "above chords". */
function relationsIn(text: string, parts: ReadonlySet<string>): string[] {
  return [...text.matchAll(RELATION)]
    .filter((match) => parts.has((match[2] as string).toLowerCase()))
    .map(
      (match) =>
        `${(match[1] as string).toLowerCase()} ${(match[2] as string).toLowerCase()}`,
    );
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
    const claim = sentencesOf(text).find(
      (sentence) => KEY_SET_CLAIM.test(sentence) && !NOT_DONE.test(sentence),
    );
    if (claim) problems.push(`says the key was set, which no change says: "${claim}"`);
  }

  const trackNames = new Set(
    [...sent.described.matchAll(/^(.+) track:/gm)].map((m) =>
      (m[1] as string).toLowerCase(),
    ),
  );
  const parts = new Set([...PARTS, ...trackNames]);
  const knownRelations = new Set(relationsIn(sources, parts));
  const relations = relationsIn(text, parts).filter(
    (claim) => !knownRelations.has(claim),
  );
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
  return strays.length > 0
    ? fail(
        `Names what the block does not: ${[...new Set(strays)].map((name) => `"${name}"`).join(", ")}`,
      )
    : pass("Names only the block's bites and chapters");
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

/**
 * 27: a question in the reply goes through `ask_producer`: a reply whose text
 * asks something without the call fails, and so does one whose text writes
 * out the call's transcript or two or more of its options. A quiz (a
 * `bite_done` turn's question) offers two to four options.
 */
export function checkAsksThroughTool(
  reply: LessonReply,
  lesson: AssistantLessonContext | null,
): CheckResult {
  if (ASK_TRANSCRIPT.test(reply.text)) {
    return fail("Writes the question's transcript into its text");
  }
  const ask = reply.ask ?? null;
  if (!ask) {
    const [question] = questionsIn(reply.text);
    return question
      ? fail(`Asks in its text without ask_producer: "${question}"`)
      : pass("Asked nothing");
  }
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
