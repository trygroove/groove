/**
 * What the basic production actions' checks (GRV-119) are built on: the
 * {@link BasicAction} a case carries, the path-by-path comparison check 19
 * (`nothingElse`) makes, the rules that say which paths an edit may touch,
 * and lookups by the fixture's own names.
 *
 * {@link checkNothingElse} compares the song and its clips leaf by leaf,
 * keyed by entity ID rather than by array position, so reordering a list is
 * not a change to every entry in it. The metadata tier is left out.
 */
import type { Clip, NoteEvent, Project, Track } from "../../domain/entities";
import { TICKS_PER_BAR } from "../../domain/time";
import type { CheckResult } from "./checks";

export const pass = (detail: string): CheckResult => ({ status: "pass", detail });
export const fail = (detail: string): CheckResult => ({ status: "fail", detail });

/** Which changed paths an edit may make: `song.tracks.<id>.mixer.muted`, ... */
export type PathRule = (path: string) => boolean;

/** One case's check: the edit asked for, and what it may touch to make it. */
export interface BasicAction {
  readonly target: (before: Project, after: Project) => CheckResult;
  /** Built from the fixture, so a rule can name what it holds by ID. */
  readonly allows: (before: Project) => PathRule;
}

// ---------------------------------------------------------------------------
// Nothing else changed
// ---------------------------------------------------------------------------

/** An array entry's key: its ID, a send's return, or its position. */
function entryKey(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const record = item as { id?: unknown; returnId?: unknown };
    if (typeof record.id === "string") return record.id;
    if (typeof record.returnId === "string") return record.returnId;
  }
  return `#${index}`;
}

/** Every leaf under `value` by path. An empty list or object has none. */
function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      flatten(item, `${path}.${entryKey(item, index)}`, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) flatten(item, `${path}.${key}`, out);
  } else {
    out.set(path, JSON.stringify(value));
  }
}

/**
 * Every leaf of the song and its clips by path, entities keyed by ID. The
 * metadata tier is left out: its revision, timestamps and derived pack list
 * move with any edit.
 */
export function leaves(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  flatten({ song: project.song, clips: project.clips }, "", out);
  return new Map([...out].map(([path, value]) => [path.slice(1), value]));
}

/** Every path whose value differs between the two projects, added and removed included. */
export function changedPaths(before: Project, after: Project): string[] {
  const was = leaves(before);
  const now = leaves(after);
  const paths = new Set([...was.keys(), ...now.keys()]);
  return [...paths].filter((path) => was.get(path) !== now.get(path)).sort();
}

/** Everything outside what the case allows is as it was. */
export function checkNothingElse(
  before: Project,
  after: Project,
  allowed: PathRule,
): CheckResult {
  const stray = changedPaths(before, after).filter((path) => !allowed(path));
  if (stray.length === 0) return pass("Nothing outside the edit changed");
  const shown = stray.slice(0, 4).join(", ");
  const more = stray.length > 4 ? ` (+${stray.length - 4} more)` : "";
  return fail(`Also changes ${shown}${more}`);
}

/** The path itself, or anything under it. */
export function under(...prefixes: readonly string[]): PathRule {
  return (path) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

export function anyOf(...rules: readonly PathRule[]): PathRule {
  return (path) => rules.some((rule) => rule(path));
}

export const NOTHING: PathRule = () => false;

/** Every track's `order`, which adding, removing or moving one may renumber. */
export const TRACK_ORDERS: PathRule = (path) => /^song\.tracks\.[^.]+\.order$/.test(path);

/** Anything under `collection` keyed by an ID `before` does not have there. */
export function added(collection: string, existing: Iterable<string>): PathRule {
  const ids = new Set(existing);
  return (path) => {
    if (!path.startsWith(`${collection}.`)) return false;
    const id = path.slice(collection.length + 1).split(".")[0];
    return !ids.has(id) && !id.startsWith("#");
  };
}

// ---------------------------------------------------------------------------
// Lookups by the fixture's names
// ---------------------------------------------------------------------------

export function trackNamed(project: Project, name: string): Track | undefined {
  return project.song.tracks.find((track) => track.name === name);
}

export function clipNamed(project: Project, name: string): Clip | undefined {
  return project.clips.find((clip) => clip.name === name);
}

/** The fixture's track by name; a missing one is a broken case, so it throws. */
export function fixtureTrack(project: Project, name: string): Track {
  const track = trackNamed(project, name);
  if (!track) throw new Error(`The fixture has no track named "${name}"`);
  return track;
}

export function fixtureClip(project: Project, name: string): Clip {
  const clip = clipNamed(project, name);
  if (!clip) throw new Error(`The fixture has no clip named "${name}"`);
  return clip;
}

export const trackPath = (project: Project, name: string) =>
  `song.tracks.${fixtureTrack(project, name).id}`;

export const clipPath = (project: Project, name: string) =>
  `clips.${fixtureClip(project, name).id}`;

export function placementsOn(project: Project, trackId: string) {
  return project.song.placements.filter((placement) => placement.trackId === trackId);
}

export function notesOf(clip: Clip | undefined): readonly NoteEvent[] {
  return clip?.content.kind === "notes" ? clip.content.events : [];
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A note's sound, its ticks plain numbers so an edited copy compares too. */
export interface Sound {
  readonly trigger: NoteEvent["trigger"];
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly velocity: number;
}

/** A clip's notes as they sound, without their IDs, sorted. */
export function soundKeys(
  events: readonly Sound[],
  map: (event: Sound) => readonly unknown[] = (event) => [
    event.trigger,
    event.startTicks,
    event.durationTicks,
    event.velocity,
  ],
): string {
  return JSON.stringify(events.map((event) => JSON.stringify(map(event))).sort());
}

/** A tick's bar, counted from 1. */
export const bar = (ticks: number) => ticks / TICKS_PER_BAR + 1;
