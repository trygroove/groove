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
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Project } from "../../domain/entities";
import type { SelectionScope, SelectionState } from "../../selection/types";
import { type AskAnswer, type AssistantAsk, answerMessage, askTranscript } from "../ask";
import { type AssistantMessage, assistantMessageSchema } from "../protocol";
import { CASE_CHECK_IDS, type CaseCheckId, type EvalExpectation } from "./caseChecks";
import type { ExpectedValue } from "./caseChecksQa";
import {
  createArrangementProject,
  createBdOnlyProject,
  createBdSketchProject,
  createHouseLoopProject,
  createKitSketchProject,
  createTechnoDrumsProject,
  createTechnoLoopProject,
} from "./fixtures";
import { FIXTURE_NAME, jsonFixturesDir, namedFixture } from "./namedFixtures";
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
  /** Stable and short: `bun run eval:assistant -- <id>` runs just this case. */
  readonly id: string;
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
  /** What the `endsAt` check holds a parameter to. */
  readonly expectedValue?: ExpectedValue;
  readonly fixture: () => Project;
  readonly selection: EvalSelection;
  readonly scope: EvalScope;
  /** The parts the request asks for, which check 7 looks for; none skips it. */
  readonly parts?: readonly EvalPart[];
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

/** A turn the panel resends: the producer's words and the reply's. */
function resentTurn(request: string, reply: string): readonly AssistantMessage[] {
  return [
    { role: "user", text: request },
    { role: "assistant", text: reply },
  ];
}

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
    checks: ["noEmptyClips", "noNoOps"],
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
  capability: z.enum(EVAL_CAPABILITIES),
  axis: z.enum(["conventional", "extreme"]),
  request: z.string().min(1),
  history: z.array(assistantMessageSchema).optional(),
  expect: z.enum(["proposal", "ask", "either"]),
  checks: z.array(z.enum(CASE_CHECK_IDS)).optional(),
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
