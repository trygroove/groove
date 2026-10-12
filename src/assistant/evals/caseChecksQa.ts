/**
 * The case checks GRV-107 adds from GRV-6's QA findings, kept apart from
 * `caseChecks.ts` so each file stays short. Each is a pure function of the
 * fixture, the project the proposal leaves and (for the last) its commands:
 *
 * - {@link checkAddsTracks}: the proposal adds at least one track.
 * - {@link checkEndsAt}: a named track parameter ends at an exact value.
 * - {@link checkNoEmptyClips}: no clip the proposal adds or changes ends with
 *   zero notes.
 * - {@link checkNoNoOps}: no command sets a value to what it already is.
 */
import { CONTROL_PARTS } from "../../commands/controlAddress";
import { executeCommand } from "../../commands/execute";
import { findCommand } from "../../commands/registry";
import type { RawCommandInput } from "../../commands/types";
import { readControl } from "../../controls/readControl";
import type { Project } from "../../domain/entities";
import { formatDb } from "../../domain/faders";
import { TRACK_VOLUME } from "../../domain/parameters";
import type { CheckResult } from "./checks";

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

// ---------------------------------------------------------------------------
// Adds tracks
// ---------------------------------------------------------------------------

/** The proposal adds at least one track to the song. */
export function checkAddsTracks(before: Project, after: Project): CheckResult {
  const existing = new Set<string>(before.song.tracks.map((track) => track.id));
  const added = after.song.tracks.filter((track) => !existing.has(track.id));
  return added.length > 0
    ? pass(`Adds ${added.length} tracks: ${added.map((track) => track.name).join(", ")}`)
    : fail("Adds no track");
}

// ---------------------------------------------------------------------------
// A parameter ends at an exact value
// ---------------------------------------------------------------------------

/** The exact value a case expects a track's parameter to end at. */
export interface ExpectedValue {
  /** The track, by the fixture's name for it. */
  readonly track: string;
  readonly parameter: "volume" | "pan";
  readonly value: number;
  /** How far off still counts, in the parameter's own unit. */
  readonly tolerance: number;
}

/** The track's parameter in `after` is the expected value, within the tolerance. */
export function checkEndsAt(
  after: Project,
  expected: ExpectedValue | undefined,
): CheckResult {
  if (!expected) return fail("The case names no expected value");
  const track = after.song.tracks.find((candidate) => candidate.name === expected.track);
  if (!track) return fail(`Removed the track "${expected.track}"`);
  const actual = track.mixer[expected.parameter];
  const show = (value: number) =>
    expected.parameter === "volume" ? formatDb(TRACK_VOLUME, value) : value.toFixed(2);
  const label = `${expected.track} ${expected.parameter}`;
  const wanted = `${show(expected.value)} within ${expected.tolerance}`;
  return Math.abs(actual - expected.value) <= expected.tolerance
    ? pass(`${label} ends at ${show(actual)} (wanted ${wanted})`)
    : fail(`${label} ends at ${show(actual)}, wanted ${wanted}`);
}

// ---------------------------------------------------------------------------
// No empty clips
// ---------------------------------------------------------------------------

/**
 * No note clip the proposal adds or changes ends with zero notes: a clip the
 * assistant created but never wrote into is silent.
 */
export function checkNoEmptyClips(before: Project, after: Project): CheckResult {
  const was = new Map(before.clips.map((clip) => [clip.id, JSON.stringify(clip)]));
  const touched = after.clips.filter((clip) => was.get(clip.id) !== JSON.stringify(clip));
  const empty = touched.filter(
    (clip) => clip.content.kind === "notes" && clip.content.events.length === 0,
  );
  if (empty.length > 0) {
    return fail(`Ends with no notes in "${empty.map((clip) => clip.name).join('", "')}"`);
  }
  return pass(`${touched.length} clips added or changed, each with notes`);
}

// ---------------------------------------------------------------------------
// No no-op commands
// ---------------------------------------------------------------------------

/**
 * The parts of an address that are structural (a list, a clip's content),
 * where equal readings do not mean nothing changed. Every other part is a
 * value: a parameter, or one of the few switches that read back whole.
 */
const VALUE_PARTS: ReadonlySet<string> = new Set([
  CONTROL_PARTS.instrument,
  CONTROL_PARTS.muted,
  CONTROL_PARTS.soloed,
  CONTROL_PARTS.bypassed,
]);
const STRUCTURAL_PARTS: ReadonlySet<string> = new Set(
  Object.values(CONTROL_PARTS).filter((part) => !VALUE_PARTS.has(part)),
);

function content(project: Project): string {
  return JSON.stringify([project.song, project.clips]);
}

/**
 * The commands, applied in order from `before`, are each a change: none
 * leaves the song and clips as they were, and none sets a value control to
 * the reading it already had ("Drum machine → Drum machine").
 */
export function checkNoNoOps(
  before: Project,
  commands: readonly RawCommandInput[],
): CheckResult {
  let working = before;
  const noOps: string[] = [];
  for (const command of commands) {
    const definition = findCommand(command.type);
    const parsed = definition?.parsePayload(command.payload);
    if (!definition || !parsed?.ok)
      return fail(`Cannot read the command ${command.type}`);
    const controls = definition.touches(parsed.payload, working);
    const readingsBefore = controls.map((address) => readControl(working, address));
    const step = executeCommand(working, command, { commitRevision: false });
    if (!step.ok)
      return fail(`${command.type} did not apply: ${step.issues[0]?.message}`);
    const same = controls.every((address, index) => {
      const was = readingsBefore[index]?.value;
      const now = readControl(step.project, address)?.value;
      return !STRUCTURAL_PARTS.has(address.param) && was != null && was === now;
    });
    const [first] = readingsBefore;
    if (controls.length > 0 && same) {
      noOps.push(`${first?.label ?? command.type}: ${first?.value} → ${first?.value}`);
    } else if (content(step.project) === content(working)) {
      noOps.push(`${command.type} changes nothing`);
    }
    working = step.project;
  }
  return noOps.length > 0
    ? fail(`Sets a value to what it already is: ${noOps.join("; ")}`)
    : pass(`${commands.length} commands, each a change`);
}
