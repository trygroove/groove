/**
 * What the producer actually did during a step (GRV-43), in a few short
 * lines Coproducer reads to comment on it: "you added a ghost note, nice".
 * Pure: a diff of two projects, the step's start and now.
 *
 * It names tracks and pads by their names, as the project context the
 * assistant already reads does; it never goes near analytics.
 */
import type { Clip, DrumPad, NoteEvent, Project, Track } from "../domain/entities";
import {
  instrumentParameters,
  readInstrumentParameter,
  SYNTH_WAVEFORM,
  synthWaveform,
} from "../domain/parameters";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import { formatSummary } from "../domain/valueFormat";
import { coveredTicks } from "./beat";

/** The most lines a description runs to. */
export const MAX_CHANGE_LINES = 8;

/**
 * The longest a line may be: what the assistant's lesson context accepts
 * for each of them (`src/assistant/lesson.ts`), so no diff can make a turn
 * the gateway refuses.
 */
export const MAX_CHANGE_LINE_LENGTH = 400;

/** Past this many hits, a line counts them rather than listing each. */
export const MAX_LISTED_HITS = 8;

/** Below this velocity a hit is soft: a ghost note. */
export const GHOST_VELOCITY = 0.5;

const KIND_WORDS = {
  synth: "synth",
  sampler: "sampler",
  drumMachine: "drum machine",
} as const;

function kindOf(track: Track): string {
  return track.instrument ? KIND_WORDS[track.instrument.kind] : "audio";
}

function eventsOf(clip: Clip | undefined): readonly NoteEvent[] {
  return clip?.content.kind === "notes" ? clip.content.events : [];
}

/** Where a note starts, as the step grid counts: "step 5", "bar 2 step 1". */
function position(note: NoteEvent): string {
  const bar = Math.floor(note.startTicks / TICKS_PER_BAR);
  const inBar = note.startTicks % TICKS_PER_BAR;
  if (inBar % TICKS_PER_SIXTEENTH !== 0)
    return bar > 0 ? `bar ${bar + 1} off the grid` : "off the grid";
  const step = `step ${inBar / TICKS_PER_SIXTEENTH + 1}`;
  return bar > 0 ? `bar ${bar + 1} ${step}` : step;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "bar 1" or "bars 1-4", for where `notes` fall. */
function barSpan(notes: readonly NoteEvent[]): string {
  const barsOf = notes.map((note) => Math.floor(note.startTicks / TICKS_PER_BAR) + 1);
  const [first, last] = [Math.min(...barsOf), Math.max(...barsOf)];
  return first === last ? `bar ${first}` : `bars ${first}-${last}`;
}

/** Where `sorted` notes fall: each listed, or counted once there are many. */
function hitPlaces(sorted: readonly NoteEvent[], change: "added" | "removed"): string {
  if (sorted.length > MAX_LISTED_HITS) {
    return `${sorted.length} hits ${change} across ${barSpan(sorted)}`;
  }
  const where = list(sorted.map(position));
  return change === "added" ? `hits added on ${where}` : `hits removed from ${where}`;
}

/** `line`, cut to {@link MAX_CHANGE_LINE_LENGTH} with an ellipsis when longer. */
function fit(line: string): string {
  return line.length <= MAX_CHANGE_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_CHANGE_LINE_LENGTH - 1)}…`;
}

function bars(ticks: number): string {
  const count = Math.round((ticks / TICKS_PER_BAR) * 100) / 100;
  return `${count} bar${count === 1 ? "" : "s"}`;
}

function noteLines(before: Project, after: Project, track: Track): string[] {
  const pads = track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
  const padName = (padId: string) =>
    pads.find((pad) => pad.id === padId)?.name ?? "a pad";
  const added: NoteEvent[] = [];
  const removed: NoteEvent[] = [];
  const clipIds = new Set(
    [...before.clips, ...after.clips]
      .filter((clip) => clip.trackId === track.id)
      .map((clip) => clip.id),
  );
  for (const clipId of clipIds) {
    const was = eventsOf(before.clips.find((clip) => clip.id === clipId));
    const now = eventsOf(after.clips.find((clip) => clip.id === clipId));
    const wasIds = new Set(was.map((note) => note.id));
    const nowIds = new Set(now.map((note) => note.id));
    added.push(...now.filter((note) => !wasIds.has(note.id)));
    removed.push(...was.filter((note) => !nowIds.has(note.id)));
  }
  const lines: string[] = [];
  const byPad = (notes: readonly NoteEvent[]) => {
    const grouped = new Map<string, NoteEvent[]>();
    for (const note of notes) {
      const key = note.trigger.kind === "pad" ? note.trigger.padId : "";
      grouped.set(key, [...(grouped.get(key) ?? []), note]);
    }
    return grouped;
  };
  for (const [padId, notes] of byPad(added)) {
    const sorted = [...notes].sort((a, b) => a.startTicks - b.startTicks);
    if (padId === "") {
      lines.push(
        `${track.name}: ${notes.length} note${notes.length === 1 ? "" : "s"} added.`,
      );
      continue;
    }
    const soft = sorted.filter((note) => note.velocity < GHOST_VELOCITY).length;
    const ghosts =
      soft > 0 ? ` (${soft} soft, a ghost note${soft === 1 ? "" : "s"})` : "";
    lines.push(
      `${track.name}'s ${padName(padId)}: ${hitPlaces(sorted, "added")}${ghosts}.`,
    );
  }
  for (const [padId, notes] of byPad(removed)) {
    const sorted = [...notes].sort((a, b) => a.startTicks - b.startTicks);
    lines.push(
      padId === ""
        ? `${track.name}: ${notes.length} note${notes.length === 1 ? "" : "s"} removed.`
        : `${track.name}'s ${padName(padId)}: ${hitPlaces(sorted, "removed")}.`,
    );
  }
  return lines;
}

function padLines(before: Track, after: Track, project: Project): string[] {
  if (
    before.instrument?.kind !== "drumMachine" ||
    after.instrument?.kind !== "drumMachine"
  ) {
    return [];
  }
  const was = new Map<string, DrumPad>(
    before.instrument.pads.map((pad) => [pad.id, pad]),
  );
  const soundName = (pad: DrumPad) =>
    project.song.assets.find((asset) => asset.id === pad.assetId)?.name ?? "no sound";
  const lines: string[] = [];
  for (const pad of after.instrument.pads) {
    const old = was.get(pad.id);
    if (!old)
      lines.push(
        `Added a pad, ${pad.name}, to ${after.name}, playing "${soundName(pad)}".`,
      );
    else if (old.assetId !== pad.assetId) {
      lines.push(`${after.name}'s ${pad.name} pad now plays "${soundName(pad)}".`);
    }
  }
  return lines;
}

function parameterLines(before: Track, after: Track): string[] {
  const instrument = after.instrument;
  if (!instrument || before.instrument?.kind !== instrument.kind) return [];
  if (instrument.kind === "drumMachine") return [];
  const show = (definition: typeof SYNTH_WAVEFORM, value: number) =>
    definition === SYNTH_WAVEFORM
      ? synthWaveform(value)
      : formatSummary(definition, value);
  const old = before.instrument;
  return instrumentParameters(instrument.kind).flatMap((definition) => {
    const was = readInstrumentParameter(definition, old?.parameters ?? {});
    const now = readInstrumentParameter(definition, instrument.parameters);
    return was === now
      ? []
      : [
          `${after.name}'s ${definition.label.toLowerCase()}: ${show(definition, was)} to ${show(definition, now)}.`,
        ];
  });
}

/**
 * What changed from `before` to `after`, a line a change, at most
 * {@link MAX_CHANGE_LINES} of at most {@link MAX_CHANGE_LINE_LENGTH}
 * characters each; empty when nothing did.
 */
export function describeChanges(before: Project, after: Project): string[] {
  const lines: string[] = [];
  if (before.song.tempo !== after.song.tempo) {
    lines.push(`Tempo: ${before.song.tempo} to ${after.song.tempo} BPM.`);
  }
  const was = new Map(before.song.tracks.map((track) => [track.id, track]));
  const now = new Set(after.song.tracks.map((track) => track.id));
  for (const track of before.song.tracks) {
    if (!now.has(track.id))
      lines.push(`Removed the ${kindOf(track)} track "${track.name}".`);
  }
  for (const track of after.song.tracks) {
    const old = was.get(track.id);
    if (!old) lines.push(`Added a ${kindOf(track)} track, "${track.name}".`);
    else {
      lines.push(...padLines(old, track, after), ...parameterLines(old, track));
    }
    lines.push(...noteLines(before, after, track));
    const covered = [coveredTicks(before, track.id), coveredTicks(after, track.id)];
    if (old && covered[0] !== covered[1]) {
      lines.push(
        `${track.name}'s clips now play for ${bars(covered[1])} (were ${bars(covered[0])}).`,
      );
    }
  }
  return lines.slice(0, MAX_CHANGE_LINES).map(fit);
}
