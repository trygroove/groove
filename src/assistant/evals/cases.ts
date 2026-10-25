/**
 * The assistant's musical eval cases (GRV-6).
 *
 * Five capabilities, each asked once conventionally and once at an extreme on
 * the same fixture, so check 6 can tell whether the extreme request was
 * flattened into the conventional answer. A case names its selection and its
 * allowed scope by the fixture's own track and clip names, which are resolved
 * to IDs when the case runs.
 *
 * GRV-99 adds cases copied from sessions in testing. They are not pairs: a
 * case may carry the conversation before its request (`history`), expect a
 * question rather than a proposal (`expect: "ask"`), and name checks of its
 * own (`checks`) beside the shared ones.
 *
 * GRV-108 adds cases saved from `bun run assistant:try`: one JSON file per
 * case in `cases/`, run against a named fixture (`namedFixtures.ts`), loaded
 * after the TypeScript ones into {@link EVAL_CASES}.
 *
 * GRV-119 adds a second set beside the musical one: the basic production
 * actions (`basicActionCases.ts`), simple exact edits each judged by checks 18
 * and 19. A case names its set (`set`, the musical one when it does not), and
 * the scorecard scores each set on its own as well as the run as a whole.
 *
 * GRV-150 adds two cases whose history holds proposals the producer applied
 * and cancelled, judged on whether the reply agrees with the project context
 * (`caseChecksContext.ts`) rather than with what was only proposed.
 *
 * GRV-145 runs a case as a session when it names `session` (`session.ts`):
 * the large, open requests, judged on the song a scripted producer ends with.
 *
 * GRV-208 adds a third set, the lessons (`lessonCases.ts`): a case may carry
 * the lesson block and the producer's memory its turn sends (`lesson`,
 * `memory`), run a bite of a lesson as a session (`lessonSession`,
 * `lessonSession.ts`), and is judged by the lesson checks it names
 * (`lessonChecks`, `lessonChecks.ts`).
 *
 * GRV-207 adds four `takes` cases: a melody, a bassline and chords on a beat,
 * each judged by check 29 (one offer of four takes, each playing notes no
 * other take plays), and drums, judged by check 30 (no takes offered).
 * GRV-213 makes a new drum pattern four takes as well: `takes-drums` asks for
 * one on a kit, judged by checks 29 and 31 (takes of a drum pattern), and
 * `takes-drum-edit` keeps an edit to the hits a pattern has one proposal,
 * judged by check 30.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Project } from "../../domain/entities";
import type { LessonId } from "../../lessons/ids";
import { lessonOfferAsk, lessonOfferText } from "../../onboarding/questions";
import type { SelectionScope, SelectionState } from "../../selection/types";
import { type AskAnswer, type AssistantAsk, answerMessage, askTranscript } from "../ask";
import { type HistoryEntry, historyOf } from "../history";
import type { AssistantLessonContext } from "../lesson";
import type { AssistantMemoryContext } from "../memory";
import { type AssistantMessage, assistantMessageSchema } from "../protocol";
import type { ProposalOutcome } from "../transcripts";
import { BASIC_ACTION_CASES } from "./basicActionCases";
import type { BasicAction } from "./basicActionChecks";
import { CASE_CHECK_IDS, type CaseCheckId, type EvalExpectation } from "./caseChecks";
import type { ProjectFacts } from "./caseChecksContext";
import type { ExpectedValue } from "./caseChecksQa";
import {
  createArrangementProject,
  createBdOnlyProject,
  createBdSdProject,
  createBdSketchProject,
  createEmptySongProject,
  createHouseLoopProject,
  createKitSketchProject,
  createStarterFixtureProject,
  createTechnoDrumsProject,
  createTechnoLoopProject,
} from "./fixtures";
import { LESSON_CASES } from "./lessonCases";
import type { LessonCheckId } from "./lessonChecks";
import type { EvalLessonScript } from "./lessonSession";
import { FIXTURE_NAME, jsonFixturesDir, namedFixture } from "./namedFixtures";
import type { EvalSetId } from "./sets";
import { EVAL_SPLITS, type EvalSplit } from "./splits";
import type { ExportedTranscriptCase, TranscriptCaseFixture } from "./transcriptCase";

/** The capabilities asked once conventionally and once at an extreme (check 6). */
export const PAIRED_CAPABILITIES = [
  "loopSketch",
  "variation",
  "arrangement",
  "balancing",
  "processing",
] as const;

export const EVAL_CAPABILITIES = [
  ...PAIRED_CAPABILITIES,
  // GRV-99's session cases.
  "density",
  "development",
  "newPart",
  // GRV-107's cases from GRV-6's QA findings.
  "sketchScope",
  "relativeLevel",
  "resketch",
  // GRV-119's basic production actions.
  "basicAction",
  // GRV-129: sounds picked for the pads a turn adds.
  "soundPicks",
  // GRV-150: replies that follow the project context, not the history.
  "projectContext",
  // GRV-208: Coproducer's lesson turns.
  "lesson",
  // GRV-207: four takes of a part to pick from.
  "takes",
] as const;
export type EvalCapability = (typeof EVAL_CAPABILITIES)[number];

/** A part of a sketch a request can ask for (check 7). */
export const EVAL_PARTS = ["drums", "bass", "chords", "melody", "texture"] as const;
export type EvalPart = (typeof EVAL_PARTS)[number];

export type EvalAxis = "conventional" | "extreme";

/**
 * What a proposal for a case may change (check 3). Tracks are named as the
 * fixture names them; `"all"` is every track the fixture has.
 */
export interface EvalScope {
  /** Existing tracks whose settings, clips, placements and devices may change. */
  readonly tracks: readonly string[] | "all";
  /** Whether new tracks (and their clips and placements) may be added. */
  readonly createTracks: boolean;
  /** Whether the song's own settings (tempo, swing, key, loop) may change. */
  readonly song: boolean;
  /** Whether the master bus (its volume, its chain) may change. */
  readonly master: boolean;
  /** Whether return buses may be added, changed or removed. */
  readonly returns: boolean;
  /** Whether sections may change. No command can change one yet. */
  readonly sections: boolean;
}

/** What the producer has selected when they ask, by the fixture's names. */
export type EvalSelection =
  | { readonly tracks: readonly string[] }
  | { readonly clips: readonly string[] }
  | null;

export interface EvalCase {
  /** Stable and short: `bun run assistant:eval -- <id>` runs just this case. */
  readonly id: string;
  /** The set the scorecard scores it in; the musical one when absent. */
  readonly set?: EvalSetId;
  /**
   * Whether experiments train on it or hold it out (GRV-110). A case written
   * here takes its split from `splits.ts`; a JSON case may name its own.
   */
  readonly split?: EvalSplit;
  readonly capability: EvalCapability;
  readonly axis: EvalAxis;
  /** The producer's words, sent as the turn's last message. */
  readonly request: string;
  /**
   * The conversation before the request, sent as it is ahead of it: what the
   * panel resends, a question the assistant asked included. Starts with the
   * producer and alternates.
   */
  readonly history?: readonly AssistantMessage[];
  /**
   * What the turn should come back with (check 8): a proposal, or a question
   * (`ask_producer`) and no proposal. Checks 1 to 7 judge any proposal it
   * makes either way.
   */
  readonly expect: EvalExpectation;
  /** Checks of its own, judged on an applied proposal beside the shared ones. */
  readonly checks?: readonly CaseCheckId[];
  /**
   * Checks every case is judged by (`EVERY_CASE_CHECKS`) that this one's
   * request makes wrong: "clear this clip" asks for the empty clip check 16
   * fails.
   */
  readonly exempt?: readonly CaseCheckId[];
  /** What the `endsAt` check holds a parameter to. */
  readonly expectedValue?: ExpectedValue;
  /** What the project has and lacks, which the reply checks hold the reply to (GRV-150). */
  readonly facts?: ProjectFacts;
  /** The edit `exactEdit` and `nothingElse` judge (GRV-119). */
  readonly action?: BasicAction;
  readonly fixture: () => Project;
  readonly selection: EvalSelection;
  readonly scope: EvalScope;
  /** The parts the request asks for, which check 7 looks for; none skips it. */
  readonly parts?: readonly EvalPart[];
  /**
   * Whether the turn carries the library (`evalLibrary.ts`), as the editor's
   * do, so the model is offered `recommend_sounds` (GRV-129).
   */
  readonly library?: boolean;
  /**
   * Runs the case as a session (GRV-145, `session.ts`): a scripted producer
   * applies each proposal and answers each question with the suggested
   * option, for up to `maxTurns` turns (`DEFAULT_SESSION_TURNS` when not
   * said), and the case's checks judge the final song. Absent, the case is
   * one turn.
   */
  readonly session?: EvalSessionOptions;
  /**
   * The lesson under way the turn carries (GRV-208, `src/assistant/lesson.ts`),
   * sent as the panel's `sendMessage` sends it. Absent, the turn is outside a
   * lesson.
   */
  readonly lesson?: AssistantLessonContext;
  /**
   * The producer's memory the turn carries (GRV-25), as the panel sends it:
   * what the lesson rules read, and what offers `start_lesson`.
   */
  readonly memory?: AssistantMemoryContext;
  /** The lesson check 24 expects the turn to start (GRV-208). */
  readonly startsLesson?: LessonId;
  /**
   * Runs the case as a lesson session (GRV-208, `lessonSession.ts`): one bite
   * of a lesson, a turn per moment, the scripted producer doing each step by
   * Show me or Skip.
   */
  readonly lessonSession?: EvalLessonScript;
  /**
   * The lesson checks it is judged by (24 to 28, `lessonChecks.ts`): on its
   * one turn, or on every turn of its lesson session. A case that names any
   * is judged on the lesson's own path: check 8 on what changes the song, and
   * no proposal check, since a lesson turn proposes nothing.
   */
  readonly lessonChecks?: readonly LessonCheckId[];
}

/** How a session case runs (GRV-145). */
export interface EvalSessionOptions {
  /** The most turns it runs; the session's default when absent. */
  readonly maxTurns?: number;
}

const NOTHING_ELSE = { song: false, master: false, returns: false, sections: false };

/** GRV-99 case 2: a broad request that should be asked about first. */
export const DEVELOP_TRACK_REQUEST =
  "I have this loop which I want to develop into a full track. It's a deep, hypnotic techno track, so I don't want big drops or anything.";

/** The question the assistant asks before developing the loop, scripted. */
const DEVELOP_TRACK_ASK: AssistantAsk = {
  id: "toolu_eval_develop_track",
  question: "How long should the track run, and how should it move?",
  context: "Developing the loop into a track",
  options: [
    {
      label: "About 5 minutes, slow changes",
      description: "Parts in and out every 16 or 32 bars",
    },
    { label: "About 7 minutes, very gradual", description: "A long DJ-friendly build" },
    { label: "Short, about 3 minutes", description: "A tight edit" },
  ],
  suggested: 0,
  multiSelect: false,
};

/** The producer's answer to it, in their own words. */
const DEVELOP_TRACK_ANSWER: AskAnswer = {
  picked: [],
  text: "About 5 minutes at 140. Keep it rolling — change things every 16 or 32 bars, never all at once. Bring the hats and percussion in and out, and use filtered or thinned-out versions of the synth rather than new sounds.",
};

/** The conversation case 2b picks up from: the request, the question, the answer. */
const DEVELOP_TRACK_HISTORY: readonly AssistantMessage[] = [
  { role: "user", text: DEVELOP_TRACK_REQUEST },
  {
    role: "assistant",
    text: `Before I lay this out, a quick question so it moves the way you want.\n\n${askTranscript(DEVELOP_TRACK_ASK)}`,
  },
];

/** GRV-99 case 3: a new part on a song whose genre may or may not be known. */
const PAD_REQUEST = "I think this track needs a high, atmospheric pad sound.";

/** What a case that may add new tracks, and change nothing else, allows. */
const NEW_TRACKS_ONLY: EvalScope = { tracks: [], createTracks: true, ...NOTHING_ELSE };

/** GRV-107: the sketch request QA sent, on a project with only BD. */
const HOUSE_SKETCH_REQUEST =
  "Sketch a four-on-the-floor house loop with drums, bass, chords, melody and a texture.";

/** GRV-107: the extreme request QA sent. */
const BROKEN_DNB_REQUEST =
  "Make a broken, lurching, abrasive drum and bass loop, no straight grid.";

/** The BD track's volume the relative-dB cases start from. */
const BD_START_DB = -3;

/** What a sketch may change: any track, new tracks, and the song's tempo. */
const SKETCH_SCOPE: EvalScope = {
  tracks: "all",
  createTracks: true,
  ...NOTHING_ELSE,
  song: true,
};

/** What a level request may change: the BD track alone. */
const BD_ONLY: EvalScope = { tracks: ["BD"], createTracks: false, ...NOTHING_ELSE };

/** A relative-dB case: BD starts at `from`, and should end at `to`. */
function relativeDbCase(
  id: string,
  request: string,
  from: number,
  to: number,
  history?: readonly AssistantMessage[],
): EvalCase {
  return {
    id,
    capability: "relativeLevel",
    axis: "conventional",
    request,
    history,
    expect: "proposal",
    fixture: () => createBdOnlyProject(from),
    selection: null,
    scope: BD_ONLY,
    checks: ["endsAt"],
    expectedValue: { track: "BD", parameter: "volume", value: to, tolerance: 0.05 },
  };
}

/** GRV-207: a new melodic or harmonic part on a drums-only loop, which check 29 holds to four takes. */
function takesCase(id: string, request: string): EvalCase {
  return {
    id,
    capability: "takes",
    axis: "conventional",
    request,
    expect: "proposal",
    fixture: createTechnoDrumsProject,
    selection: null,
    scope: NEW_TRACKS_ONLY,
    checks: ["offersTakes"],
  };
}

/** The first lesson onboarding offers a producer who wants to finish a track. */
const FIRST_LESSON_ASK = lessonOfferAsk("first_track");

/** The conversation the lesson offer ends: the producer's goal, then Coproducer's offer. */
const FIRST_LESSON_HISTORY: readonly AssistantMessage[] = [
  { role: "user", text: "My goal is to finish my first track." },
  {
    role: "assistant",
    text: `${lessonOfferText("first_track", "studio")}\n\n${askTranscript(FIRST_LESSON_ASK)}`,
  },
];

/** A turn the panel resends: the producer's words and the reply's. */
function resentTurn(request: string, reply: string): readonly AssistantMessage[] {
  return [
    { role: "user", text: request },
    { role: "assistant", text: reply },
  ];
}

/**
 * One turn as the panel logs it (GRV-150): the producer's message, the reply,
 * and, when the reply proposed a change, what the producer did with it. The
 * case's history is built from these by the panel's own {@link historyOf}, so
 * the eval sends what the editor would.
 */
function loggedTurn(
  request: string,
  reply: string,
  proposal?: ProposalOutcome,
): HistoryEntry[] {
  return [
    { kind: "message", text: request },
    { kind: "reply", text: reply, ...(proposal ? { proposal } : {}) },
    ...(proposal ? [{ kind: "proposal" } as const] : []),
  ];
}

/** GRV-150: the snare the producer asked for and applied, as the SD track. */
const SNARE_APPLIED = loggedTurn(
  "add a snare on beats 2 and 4",
  "I'll add a snare on beats 2 and 4: a new drum machine track, SD, with one snare pad playing the backbeat, looped under the BD.",
  "applied",
);

/**
 * GRV-150's QA session up to "make the snare a little brighter", turn for
 * turn: the snare applied, turned down and applied, a question about what
 * changed, and (after a reload) a Closed Hat cancelled. QA did not quote the
 * answer to "what did you just change?"; this one is what a model that never
 * learns what became of its proposals can say, and what "I never actually
 * added it" a turn later builds on. A case whose history leaves these turns
 * out, or answers that question as if it knew, passed without the fix.
 */
const QA_SESSION: readonly HistoryEntry[] = [
  ...SNARE_APPLIED,
  ...loggedTurn(
    "make it quieter",
    "I'll bring the SD down 6 dB, from 0.0 dB to -6.0 dB, so the snare sits behind the kick.",
    "applied",
  ),
  ...loggedTurn(
    "what did you just change?",
    "I proposed two changes: a new SD drum machine track with a snare on beats 2 and 4, then turning the SD down from 0.0 dB to -6.0 dB. Both were proposals for you to apply, so I can't tell from here whether either of them actually went in.",
  ),
  ...loggedTurn(
    "add a closed hi-hat on the offbeats",
    "I'll add a Closed Hat: a new drum machine track with one closed hi-hat pad on every offbeat 8th, looped under the kick and snare.",
    "cancelled",
  ),
];

/** QA's reply to "make the snare a little brighter", which the next turn resent. */
const SNARE_DENIED = loggedTurn(
  "make the snare a little brighter",
  "There's no snare track in the project yet — I never actually added it. Want me to add one now, with a brighter snare on beats 2 and 4?",
);

/** What the producer's track names and the snare's own word call the SD track. */
const SNARE_WORDS = ["snare", "SD"];

/**
 * The cases written here, in TypeScript. Tests that pin what a particular
 * case says read these, not {@link EVAL_CASES}, so a case saved as JSON can
 * never break them.
 */
export const TYPESCRIPT_CASES: readonly EvalCase[] = [
  {
    id: "sketch-house",
    capability: "loopSketch",
    axis: "conventional",
    request:
      "Sketch a four-bar house loop from this kit: a four-on-the-floor beat, a bassline, chords, a melody and a soft pad texture.",
    expect: "proposal",
    fixture: createKitSketchProject,
    selection: { tracks: ["Drums"] },
    // A sketch may set its own tempo and swing.
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    parts: EVAL_PARTS,
  },
  {
    id: "sketch-broken",
    capability: "loopSketch",
    axis: "extreme",
    request:
      "Sketch a four-bar loop from this kit that sounds broken and lurching: drums that stumble off the grid, a bassline that fights them, dissonant clustered chords, a jagged melody and a harsh, noisy texture.",
    expect: "proposal",
    fixture: createKitSketchProject,
    selection: { tracks: ["Drums"] },
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    parts: EVAL_PARTS,
  },
  {
    id: "variation-fill",
    capability: "variation",
    axis: "conventional",
    request:
      "Make a variation of this drum loop as a new clip: the same feel, a few extra hats and a fill at the end of the bar.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: { clips: ["House beat"] },
    scope: { tracks: ["Drums"], createTracks: false, ...NOTHING_ELSE },
  },
  {
    id: "variation-mangled",
    capability: "variation",
    axis: "extreme",
    request:
      "Make a variation of this drum loop as a new clip that is barely recognisable: broken, lurching and abrasive.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: { clips: ["House beat"] },
    scope: { tracks: ["Drums"], createTracks: false, ...NOTHING_ELSE },
  },
  {
    id: "arrange-build-drop",
    capability: "arrangement",
    axis: "conventional",
    request:
      "Arrange these parts across the sections: a sparse intro, a build that brings parts in one by one, a full drop and an outro that strips back down.",
    expect: "proposal",
    fixture: createArrangementProject,
    selection: { tracks: ["Drums", "Bass", "Chords", "Lead"] },
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE },
  },
  {
    id: "arrange-no-build",
    capability: "arrangement",
    axis: "extreme",
    request:
      "Arrange these parts with no build at all: slam straight into the full drop from bar one, cut everything to silence for a bar at a few unexpected points, and end abruptly mid-phrase.",
    expect: "proposal",
    fixture: createArrangementProject,
    selection: { tracks: ["Drums", "Bass", "Chords", "Lead"] },
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE },
  },
  {
    id: "balance-clean",
    capability: "balancing",
    axis: "conventional",
    request:
      "Balance the mix: kick and bass up front, the chords and lead tucked in behind them, and a little stereo width.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: "all", createTracks: false, ...NOTHING_ELSE },
  },
  {
    id: "balance-lopsided",
    capability: "balancing",
    axis: "extreme",
    request:
      "Make the mix lopsided and extreme: drums hard left, the bass buried, the lead far too loud and hard right.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: "all", createTracks: false, ...NOTHING_ELSE },
  },
  {
    id: "process-glue",
    capability: "processing",
    axis: "conventional",
    request: "Add a compressor on the master to glue the mix.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: [], createTracks: false, ...NOTHING_ELSE, master: true },
  },
  {
    id: "process-crushed",
    capability: "processing",
    axis: "extreme",
    request:
      "Mangle the master: crush it with brutal compression and drive it until it distorts.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: [], createTracks: false, ...NOTHING_ELSE, master: true },
  },
  // GRV-99: sessions copied from testing.
  {
    id: "density-hats",
    capability: "density",
    axis: "conventional",
    request: "Increase the density of the hihats in this clip",
    expect: "proposal",
    fixture: createTechnoDrumsProject,
    selection: { tracks: ["Drums"] },
    scope: { tracks: ["Drums"], createTracks: false, ...NOTHING_ELSE },
    checks: ["hatDensity", "pointsToGenerate"],
  },
  {
    id: "develop-track-ask",
    capability: "development",
    axis: "conventional",
    request: DEVELOP_TRACK_REQUEST,
    expect: "ask",
    fixture: createTechnoLoopProject,
    selection: null,
    // A full track may set its own loop range.
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
  },
  {
    id: "develop-track-arrange",
    capability: "development",
    axis: "conventional",
    request: answerMessage(DEVELOP_TRACK_ASK, DEVELOP_TRACK_ANSWER),
    history: DEVELOP_TRACK_HISTORY,
    expect: "proposal",
    fixture: createTechnoLoopProject,
    selection: null,
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    checks: ["developsTrack"],
    // GRV-145: a whole track may be built over several proposals, so the
    // case runs as a session and check 11 judges the song it ends with.
    session: {},
  },
  // GRV-145: large, open requests, each run as a session.
  {
    id: "full-track-empty",
    capability: "development",
    axis: "conventional",
    request: "Make me a full track.",
    expect: "proposal",
    fixture: createEmptySongProject,
    selection: null,
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    checks: ["developsTrack", "addsTracks"],
    session: {},
  },
  {
    id: "full-tune-loop",
    capability: "development",
    axis: "conventional",
    request: "Make this a full tune.",
    expect: "proposal",
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    checks: ["developsTrack"],
    session: {},
  },
  {
    id: "pad-genre-known",
    capability: "newPart",
    axis: "conventional",
    request: PAD_REQUEST,
    history: [
      { role: "user", text: "This is a deep, hypnotic techno track at 140" },
      {
        role: "assistant",
        text: "Got it: deep, hypnotic techno at 140. I'll keep that in mind for whatever we add next.",
      },
    ],
    expect: "proposal",
    fixture: createTechnoLoopProject,
    selection: null,
    scope: NEW_TRACKS_ONLY,
    checks: ["padSound", "dissonant"],
  },
  {
    id: "pad-genre-unknown",
    capability: "newPart",
    axis: "conventional",
    request: PAD_REQUEST,
    expect: "ask",
    fixture: createTechnoLoopProject,
    selection: null,
    scope: NEW_TRACKS_ONLY,
  },
  // GRV-107: GRV-6's QA findings.
  {
    id: "sketch-whole-song",
    capability: "sketchScope",
    axis: "conventional",
    request: HOUSE_SKETCH_REQUEST,
    expect: "proposal",
    fixture: createBdOnlyProject,
    selection: null,
    scope: SKETCH_SCOPE,
    checks: ["addsTracks"],
  },
  {
    id: "sketch-track-scope",
    capability: "sketchScope",
    axis: "conventional",
    request: HOUSE_SKETCH_REQUEST,
    // A proposal that adds tracks, or a question about widening the scope.
    expect: "either",
    fixture: createBdOnlyProject,
    selection: { tracks: ["BD"] },
    scope: SKETCH_SCOPE,
    checks: ["addsTracks"],
  },
  relativeDbCase("db-nudge-down", "Nudge the BD down 1 dB", BD_START_DB, -4),
  relativeDbCase("db-turn-down", "Turn the BD down by 1 dB", BD_START_DB, -4),
  relativeDbCase("db-lower", "Lower the BD by 1 dB", BD_START_DB, -4),
  relativeDbCase("db-turn-up", "Turn the BD up by 3 dB", BD_START_DB, 0),
  // The panel resends what the reply said, whether or not the change stuck.
  relativeDbCase(
    "db-stale-cancelled",
    "Turn the BD up by 3 dB",
    BD_START_DB,
    0,
    resentTurn(
      "Turn the BD down by 2 dB",
      "I'll lower the BD volume from -3.0 dB to -5.0 dB.",
    ),
  ),
  relativeDbCase(
    "db-stale-undone",
    "Turn the BD down by 3 dB",
    0,
    -3,
    resentTurn(
      "Turn the BD down by 2 dB",
      "I'll lower the BD volume from 0.0 dB to -2.0 dB.",
    ),
  ),
  {
    id: "resketch-extreme",
    capability: "resketch",
    axis: "extreme",
    request: BROKEN_DNB_REQUEST,
    history: resentTurn(
      HOUSE_SKETCH_REQUEST,
      "I've sketched a four-on-the-floor house loop: the BD kicks, an offbeat bass, Am chords, a short melody and a held texture.",
    ),
    expect: "proposal",
    fixture: createBdSketchProject,
    selection: null,
    scope: SKETCH_SCOPE,
    checks: ["noNoOps"],
  },
  {
    id: "noop-bd-only",
    capability: "resketch",
    axis: "extreme",
    request: BROKEN_DNB_REQUEST,
    expect: "proposal",
    fixture: createBdOnlyProject,
    selection: null,
    scope: SKETCH_SCOPE,
    checks: ["noNoOps"],
  },
  // GRV-129: the first-beat lesson's turn, which adds a drum machine and
  // picks a sound for each of its pads.
  {
    id: "first-beat-lesson",
    capability: "soundPicks",
    axis: "conventional",
    request: answerMessage(FIRST_LESSON_ASK, { picked: [0], text: "" }),
    history: FIRST_LESSON_HISTORY,
    expect: "proposal",
    fixture: createStarterFixtureProject,
    selection: null,
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
    checks: ["recommendationTargets"],
    library: true,
  },
  {
    id: "snare-hats-sounds",
    capability: "soundPicks",
    axis: "conventional",
    request: "Add a snare and hats, and pick sounds for them",
    expect: "proposal",
    fixture: createStarterFixtureProject,
    selection: null,
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE },
    checks: ["recommendationTargets"],
    library: true,
  },
  // GRV-150: replies that contradicted the project context in QA.
  {
    id: "context-applied-snare",
    capability: "projectContext",
    axis: "conventional",
    request: "make the snare a little brighter",
    history: historyOf(QA_SESSION),
    expect: "proposal",
    fixture: () => createBdSdProject(-6),
    selection: null,
    scope: { tracks: ["SD"], createTracks: false, ...NOTHING_ELSE },
    checks: ["noDeniedTrack"],
    facts: { present: SNARE_WORDS },
  },
  {
    id: "context-cancelled-hat",
    capability: "projectContext",
    axis: "conventional",
    request: "is anything muted right now?",
    history: historyOf([...QA_SESSION, ...SNARE_DENIED]),
    expect: "explain",
    fixture: () => createBdSdProject(-6),
    selection: null,
    scope: { tracks: [], createTracks: false, ...NOTHING_ELSE },
    checks: ["noAbsentTrack", "noDeniedTrack"],
    facts: { present: SNARE_WORDS, absent: ["closed hat", "hi-hat", "hat"] },
  },
  // GRV-207: a melodic or harmonic part gets four takes to pick from, and so
  // does a new drum pattern (GRV-213); an edit to the hits a pattern has does
  // not. Checks 1 to 5 judge the first take, as the producer who picks it.
  takesCase("takes-melody", "Write me a lead melody over this beat."),
  takesCase("takes-bass", "Give me a bassline for this beat."),
  takesCase("takes-chords", "Add some chords over this."),
  {
    id: "takes-drums",
    capability: "takes",
    axis: "conventional",
    request: "Write me a proper drum pattern for this kit.",
    expect: "proposal",
    fixture: createKitSketchProject,
    selection: { tracks: ["Drums"] },
    scope: { tracks: ["Drums"], createTracks: false, ...NOTHING_ELSE },
    checks: ["offersTakes", "drumTakes"],
  },
  {
    id: "takes-drum-edit",
    capability: "takes",
    axis: "conventional",
    request: "Make the hi-hats busier.",
    expect: "proposal",
    fixture: createTechnoDrumsProject,
    selection: { tracks: ["Drums"] },
    scope: { tracks: ["Drums"], createTracks: false, ...NOTHING_ELSE },
    checks: ["noTakes"],
  },
  // GRV-119: the basic production actions, a set of their own.
  ...BASIC_ACTION_CASES,
  // GRV-208: Coproducer's lesson turns, a set of their own.
  ...LESSON_CASES,
];

// ---------------------------------------------------------------------------
// GRV-108: cases saved from `bun run assistant:try`, one JSON file each.
// ---------------------------------------------------------------------------

const evalScopeSchema = z.strictObject({
  tracks: z.union([z.literal("all"), z.array(z.string().min(1))]),
  createTracks: z.boolean(),
  song: z.boolean(),
  master: z.boolean(),
  returns: z.boolean(),
  sections: z.boolean(),
});

const evalSelectionSchema = z.union([
  z.strictObject({ tracks: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ clips: z.array(z.string().min(1)).min(1) }),
  z.null(),
]);

/**
 * A case as its JSON file holds it: an {@link EvalCase} with the fixture
 * named (a `fixtures.ts` builder or a JSON fixture, see `namedFixtures.ts`)
 * rather than built.
 */
export const jsonEvalCaseSchema = z.strictObject({
  id: z.string().regex(FIXTURE_NAME, "lower-case words joined by hyphens"),
  split: z.enum(EVAL_SPLITS).optional(),
  capability: z.enum(EVAL_CAPABILITIES),
  axis: z.enum(["conventional", "extreme"]),
  request: z.string().min(1),
  history: z.array(assistantMessageSchema).optional(),
  expect: z.enum(["proposal", "ask", "either", "explain"]),
  checks: z.array(z.enum(CASE_CHECK_IDS)).optional(),
  exempt: z.array(z.enum(CASE_CHECK_IDS)).optional(),
  expectedValue: z
    .strictObject({
      track: z.string().min(1),
      parameter: z.enum(["volume", "pan"]),
      value: z.number(),
      tolerance: z.number().min(0),
    })
    .optional(),
  fixture: z.string().regex(FIXTURE_NAME),
  selection: evalSelectionSchema,
  scope: evalScopeSchema,
  parts: z.array(z.enum(EVAL_PARTS)).optional(),
  session: z
    .strictObject({ maxTurns: z.number().int().min(1).max(10).optional() })
    .optional(),
});
export type JsonEvalCase = z.infer<typeof jsonEvalCaseSchema>;

/** Where the JSON cases live, from the repository root the tools run in. */
export function jsonCasesDir(): string {
  return resolve("src/assistant/evals/cases");
}

/** Parses a JSON case, or throws naming `label` and what is wrong with it. */
export function parseJsonEvalCase(raw: unknown, label: string): JsonEvalCase {
  const parsed = jsonEvalCaseSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} is not an eval case: ${issues}`);
}

/** The case a JSON case runs as, its fixture looked up in `fixturesDir`. */
export function evalCaseFromJson(
  json: JsonEvalCase,
  fixturesDir = jsonFixturesDir(),
): EvalCase {
  const { fixture, ...rest } = json;
  return { ...rest, fixture: namedFixture(fixture, fixturesDir) };
}

/**
 * Every JSON case in `casesDir`, sorted by file name. A file must be named
 * for its case's ID; one that does not parse, or names no fixture there is,
 * throws, so a broken case fails the suite rather than going missing.
 */
export function loadJsonCases(
  casesDir = jsonCasesDir(),
  fixturesDir = jsonFixturesDir(),
): EvalCase[] {
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const path = join(casesDir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(
          `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const json = parseJsonEvalCase(raw, path);
      if (`${json.id}.json` !== file) {
        throw new Error(`${path} holds the case "${json.id}"; name it ${json.id}.json`);
      }
      return evalCaseFromJson(json, fixturesDir);
    });
}

/** Every case: the TypeScript ones, then the JSON ones saved beside them. */
export const EVAL_CASES: readonly EvalCase[] = [...TYPESCRIPT_CASES, ...loadJsonCases()];

/** The messages a case's turn sends: its history, then its request. */
export function caseMessages(evalCase: EvalCase): AssistantMessage[] {
  return [...(evalCase.history ?? []), { role: "user", text: evalCase.request }];
}

/**
 * The conventional/extreme pairs, by capability: check 6 compares each
 * extreme case's proposals with its capability's conventional ones.
 */
export function casePairs(
  cases: readonly EvalCase[] = EVAL_CASES,
): { conventional: EvalCase; extreme: EvalCase }[] {
  return PAIRED_CAPABILITIES.flatMap((capability) => {
    const conventional = cases.find(
      (entry) => entry.capability === capability && entry.axis === "conventional",
    );
    const extreme = cases.find(
      (entry) => entry.capability === capability && entry.axis === "extreme",
    );
    return conventional && extreme ? [{ conventional, extreme }] : [];
  });
}

function trackIdsByName(project: Project, names: readonly string[]): string[] {
  return names.map((name) => {
    const track = project.song.tracks.find((candidate) => candidate.name === name);
    if (!track) throw new Error(`The fixture has no track named "${name}"`);
    return track.id;
  });
}

/** The case's selection in `project`, as the editor would hold it. */
export function resolveSelection(
  project: Project,
  selection: EvalSelection,
): SelectionState | undefined {
  if (!selection) return undefined;
  const scopes: SelectionScope[] =
    "tracks" in selection
      ? trackIdsByName(project, selection.tracks).map(
          (id) => ({ kind: "track", id }) as SelectionScope,
        )
      : selection.clips.map((name) => {
          const clip = project.clips.find((candidate) => candidate.name === name);
          if (!clip) throw new Error(`The fixture has no clip named "${name}"`);
          return { kind: "clip", id: clip.id };
        });
  return { scopes, focus: scopes[0] ?? null };
}

/** The scope with its track names resolved to IDs in `project`. */
export interface ResolvedScope extends Omit<EvalScope, "tracks"> {
  readonly tracks: ReadonlySet<string>;
}

export function resolveScope(project: Project, scope: EvalScope): ResolvedScope {
  const tracks =
    scope.tracks === "all"
      ? project.song.tracks.map((track) => track.id)
      : trackIdsByName(project, scope.tracks);
  return { ...scope, tracks: new Set(tracks) };
}

/** The project each transcript case fixture name stands for (GRV-98). */
export const TRANSCRIPT_FIXTURE_PROJECTS: Readonly<
  Record<TranscriptCaseFixture, () => Project>
> = {
  "house-loop": createHouseLoopProject,
  "kit-sketch": createKitSketchProject,
  arrangement: createArrangementProject,
};

/**
 * The eval case a kept turn's file runs as (GRV-98): its message against its
 * fixture, free to change any track and to add tracks (a real request has no
 * scope the eval knows), expecting a proposal, with no parts for check 7 to look for.
 */
export function evalCaseFromTranscript(exported: ExportedTranscriptCase): EvalCase {
  return {
    id: `transcript-${exported.turnId}`,
    capability: "loopSketch",
    axis: "conventional",
    request: exported.request,
    expect: "proposal",
    fixture: TRANSCRIPT_FIXTURE_PROJECTS[exported.fixture],
    selection: null,
    scope: {
      tracks: "all",
      createTracks: true,
      song: true,
      master: true,
      returns: true,
      sections: false,
    },
  };
}
