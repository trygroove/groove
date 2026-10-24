/**
 * The lessons set (GRV-208): Coproducer's lesson turns, each case from a QA
 * finding of GRV-43 or GRV-44, where the model said it would start a lesson
 * without calling `start_lesson`, echoed a bracketed history note, wrote a
 * quiz out as text instead of calling `ask_producer`, or described the music
 * wrongly.
 *
 * Three kinds of case:
 *
 * - **Starting one**: a request for a lesson, with the producer's memory (the
 *   panel sends it, and only a turn with it is offered `start_lesson`),
 *   judged by check 24 on the call and 28 on the text.
 * - **A bite as a session** (`lessonSession.ts`): the lesson walked by Show
 *   me to the bite's start on the starter project, then one turn per moment
 *   of the bite, the scripted producer doing each step by Show me or Skip,
 *   every turn judged by checks 25 to 28.
 * - **A question mid-lesson**: one `under_way` turn, the lesson block built
 *   by the same walk, judged by 25 to 28.
 *
 * Every case expects `explain`: check 8 fails a turn that changes the song.
 * The fixtures are built from `src/testing/lessonWorld.ts`'s starter world;
 * no production project was needed.
 */

import type { LessonSettings } from "../../lessons/types";
import { starterWorld } from "../../testing/lessonWorld";
import { type HistoryEntry, historyOf } from "../history";
import type { AssistantMemoryContext } from "../memory";
import type { AssistantMessage } from "../protocol";
import type { EvalCase, EvalScope } from "./cases";
import { LESSON_TURN_CHECKS } from "./lessonChecks";
import {
  type EvalLessonScript,
  finishedChapter,
  lessonBlockFor,
  lessonFixture,
  lessonOpening,
  lessonWalk,
} from "./lessonSession";

const HOUSE: LessonSettings = { style: "four_on_the_floor" };
const BOOM_BAP: LessonSettings = { style: "boom_bap" };

/** `build`'s result, built once: the starter project mints fresh IDs on every call. */
function once<T>(build: () => T): () => T {
  let built: { value: T } | null = null;
  return () => {
    built ??= { value: build() };
    return built.value;
  };
}

/** The project a new producer opens: BD with four on the floor. */
const starterProject = once(() => starterWorld().project);
const afterBeat = once(() => finishedChapter("beat", HOUSE));

/** A lesson turn may change nothing. */
const NO_SCOPE: EvalScope = {
  tracks: [],
  createTracks: false,
  song: false,
  master: false,
  returns: false,
  sections: false,
};

/** A producer who has played around a little and wants a first track. */
function memoryOf(taste: string): AssistantMemoryContext {
  return {
    taste: [taste],
    artists: taste === "house" ? "Disclosure, Kerri Chandler" : "J Dilla, Madlib",
    experience: "played_around",
    goal: "first_track",
    learn: ["drums", "arranging"],
    gear: [],
    notes: [],
    askLater: null,
  };
}

const HOUSE_MEMORY = memoryOf("house");
const HIP_HOP_MEMORY = memoryOf("hip hop");

const common = {
  set: "lessons",
  capability: "lesson",
  axis: "conventional",
  expect: "explain",
  selection: null,
  scope: NO_SCOPE,
} as const satisfies Partial<EvalCase>;

/** The conversation as it stands once the producer asked for `chapter` and the reply started it. */
function startedWith(
  request: string,
  reply: string,
  chapter: "beat" | "sound" | "tour" | "track",
): AssistantMessage[] {
  return historyOf([
    { kind: "message", text: request },
    { kind: "reply", text: reply, lesson: chapter },
  ]);
}

const TRACK_STARTED = startedWith(
  "finish a track with me",
  "Let's finish a track together, from the beat to the stems. The card's in the panel.",
  "track",
);
const BEAT_STARTED = startedWith(
  "teach me to make a beat",
  "Let's make a beat, one bite at a time. The card's in the panel.",
  "beat",
);
const TOUR_STARTED = startedWith(
  "show me around",
  "Let's take a tour of the studio, one view at a time. The card's in the panel.",
  "tour",
);

/** What Coproducer said at each moment of the finished chapter, kept short. */
const CANNED_REPLIES = {
  bite_started: "Here's what this bite is for. Have a go, or press Show me.",
  step_done: "Nice, that's in. On to the next step when you're ready.",
  bite_done: "That's the bite done. Go on to the next when you want.",
  chapter_done: "That's your first beat, looping for four bars. Well done.",
  track_done: "That's a finished track.",
  under_way: "Good question.",
} as const;

/**
 * The conversation of a whole "Make a beat" (GRV-43 r1 F2, r2 F1): its start,
 * then every lesson turn with a short reply, as the panel resends it.
 */
function finishedBeatHistory(): AssistantMessage[] {
  const { lines } = afterBeat();
  const entries: HistoryEntry[] = [
    { kind: "message", text: "teach me to make a beat" },
    {
      kind: "reply",
      text: "Let's make a beat, one bite at a time. The card's in the panel.",
      lesson: "beat",
    },
    ...lines.flatMap((line): HistoryEntry[] => [
      { kind: "message", text: line.text },
      { kind: "reply", text: CANNED_REPLIES[line.moment] },
    ]),
  ];
  return historyOf(entries);
}

/** A bite of a lesson, run as a session (`lessonSession.ts`). */
function biteCase(
  id: string,
  script: EvalLessonScript,
  history: readonly AssistantMessage[],
): EvalCase {
  return {
    ...common,
    id,
    request: lessonOpening(script),
    history,
    fixture: lessonFixture(script),
    memory: script.settings.style === "four_on_the_floor" ? HOUSE_MEMORY : HIP_HOP_MEMORY,
    lessonSession: script,
    lessonChecks: LESSON_TURN_CHECKS,
  };
}

const START_CHECKS = ["startsLesson", "noHistoryNote"] as const;

/** A mid-lesson question at the start of boom bap's backbeat (GRV-43). */
const BACKBEAT: EvalLessonScript = {
  track: false,
  chapter: "beat",
  bite: "beat-snare",
  how: "show_me",
  settings: BOOM_BAP,
};

export const LESSON_CASES: readonly EvalCase[] = [
  // GRV-43 r1 F2, r2 F1: after a finished chapter, a new lesson got
  // "Starting it now" and no call.
  {
    ...common,
    id: "teach-me-beat-after-chapter",
    request: "teach me to shape a sound",
    history: finishedBeatHistory(),
    fixture: () => afterBeat().project,
    memory: HOUSE_MEMORY,
    startsLesson: "sound",
    lessonChecks: START_CHECKS,
  },
  // GRV-44 r2 F2: "finish a track" on a new project got a question instead.
  {
    ...common,
    id: "finish-track-new-project",
    request: "finish a track with me",
    fixture: starterProject,
    memory: HOUSE_MEMORY,
    startsLesson: "track",
    lessonChecks: START_CHECKS,
  },
  // GRV-43 r2 F1: the bracketed note after a reply that started a lesson
  // came back in the producer's view.
  {
    ...common,
    id: "lesson-start-no-echo",
    request: "take me on a tour of the studio",
    history: BEAT_STARTED,
    fixture: starterProject,
    memory: HOUSE_MEMORY,
    startsLesson: "tour",
    lessonChecks: START_CHECKS,
  },
  // GRV-44 r2 F3: the hook Show me wrote was called "A5-F5, above the chords".
  // Today's Show me writes it at A4-F5 over chords at A3-D5 (`chords.ts`
  // counts the hook up from C4), not A3-F4 under them as on the QA project,
  // and `changes` names no pitch ("Hook: 8 notes added in bar 1."): the
  // registers come with the description, and check 25 judges a range or an
  // above/below claim against those.
  biteCase(
    "hook-shown",
    {
      track: true,
      chapter: "chords",
      bite: "chords-hook",
      how: "show_me",
      settings: HOUSE,
    },
    TRACK_STARTED,
  ),
  // GRV-44 r1 F3: "12 notes, two triads per bar" over four bars of 4 chords of 3.
  biteCase(
    "chords-shown",
    {
      track: true,
      chapter: "chords",
      bite: "chords-loop",
      how: "show_me",
      settings: HOUSE,
    },
    TRACK_STARTED,
  ),
  // GRV-44 r1 F1: "set the key to A minor" when Show me had only added the Bass track.
  biteCase(
    "key-show-me",
    { track: true, chapter: "bass", bite: "bass-key", how: "show_me", settings: HOUSE },
    TRACK_STARTED,
  ),
  // GRV-43 r1 F4: a skipped bite pointed at "Sections", which no chapter has.
  biteCase(
    "skip-names-next",
    {
      track: false,
      chapter: "tour",
      bite: "tour-arrangement",
      how: "skipped",
      settings: HOUSE,
    },
    TOUR_STARTED,
  ),
  // GRV-44 r2: the quiz written out as text, options and all, instead of ask_producer.
  biteCase(
    "quiz-is-a-call",
    { track: false, chapter: "beat", bite: "beat-hats", how: "show_me", settings: HOUSE },
    BEAT_STARTED,
  ),
  // GRV-43's spec, GRV-129: the chapter's wrap-up, with its three pointers.
  // Check 26 holds it to two or three of them, 27 to no question and no quiz.
  biteCase(
    "wrap-up-once",
    { track: false, chapter: "beat", bite: "beat-loop", how: "show_me", settings: HOUSE },
    BEAT_STARTED,
  ),
  // GRV-43's spec: a question of the producer's own, mid-lesson.
  {
    ...common,
    id: "under-way-question",
    request: "why does the snare go on 2 and 4?",
    history: startedWith(
      "teach me to make a beat",
      "Let's make a beat, one bite at a time. The card's in the panel.",
      "beat",
    ),
    fixture: lessonFixture(BACKBEAT),
    memory: HIP_HOP_MEMORY,
    lesson: (() => {
      const walk = lessonWalk(BACKBEAT);
      return lessonBlockFor(walk.transition.state, null, BACKBEAT.settings, walk.done);
    })(),
    lessonChecks: LESSON_TURN_CHECKS,
  },
];
