/**
 * The assistant's musical eval cases (GRV-6).
 *
 * Five capabilities, each asked once conventionally and once at an extreme on
 * the same fixture, so check 6 can tell whether the extreme request was
 * flattened into the conventional answer. A case names its selection and its
 * allowed scope by the fixture's own track and clip names, which are resolved
 * to IDs when the case runs.
 */
import type { Project } from "../../domain/entities";
import type { SelectionScope, SelectionState } from "../../selection/types";
import {
  createArrangementProject,
  createHouseLoopProject,
  createKitSketchProject,
} from "./fixtures";

export const EVAL_CAPABILITIES = [
  "loopSketch",
  "variation",
  "arrangement",
  "balancing",
  "processing",
] as const;
export type EvalCapability = (typeof EVAL_CAPABILITIES)[number];

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
  /** The producer's words, sent as the turn's one message. */
  readonly request: string;
  readonly fixture: () => Project;
  readonly selection: EvalSelection;
  readonly scope: EvalScope;
}

const NOTHING_ELSE = { song: false, master: false, returns: false, sections: false };

export const EVAL_CASES: readonly EvalCase[] = [
  {
    id: "sketch-house",
    capability: "loopSketch",
    axis: "conventional",
    request:
      "Sketch a four-bar house loop from this kit: a four-on-the-floor beat, a bassline, chords, a melody and a soft pad texture.",
    fixture: createKitSketchProject,
    selection: { tracks: ["Drums"] },
    // A sketch may set its own tempo and swing.
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
  },
  {
    id: "sketch-broken",
    capability: "loopSketch",
    axis: "extreme",
    request:
      "Sketch a four-bar loop from this kit that sounds broken and lurching: drums that stumble off the grid, a bassline that fights them, dissonant clustered chords, a jagged melody and a harsh, noisy texture.",
    fixture: createKitSketchProject,
    selection: { tracks: ["Drums"] },
    scope: { tracks: "all", createTracks: true, ...NOTHING_ELSE, song: true },
  },
  {
    id: "variation-fill",
    capability: "variation",
    axis: "conventional",
    request:
      "Make a variation of this drum loop as a new clip: the same feel, a few extra hats and a fill at the end of the bar.",
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
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: "all", createTracks: false, ...NOTHING_ELSE },
  },
  {
    id: "process-glue",
    capability: "processing",
    axis: "conventional",
    request: "Add a compressor on the master to glue the mix.",
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
    fixture: createHouseLoopProject,
    selection: null,
    scope: { tracks: [], createTracks: false, ...NOTHING_ELSE, master: true },
  },
];

/**
 * The conventional/extreme pairs, by capability: check 6 compares each
 * extreme case's proposals with its capability's conventional ones.
 */
export function casePairs(
  cases: readonly EvalCase[] = EVAL_CASES,
): { conventional: EvalCase; extreme: EvalCase }[] {
  return EVAL_CAPABILITIES.flatMap((capability) => {
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
