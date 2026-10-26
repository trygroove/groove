import type { BucketLabel } from "../../analytics/buckets";
import { bucketOf } from "../../analytics/buckets";
import {
  CLIP_LENGTH_BARS,
  MAX_CLIP_LENGTH_BARS,
  MIN_CLIP_LENGTH_BARS,
} from "../../domain/clipLength";
import type { Clip, Instrument, NoteEvent, NoteTrigger } from "../../domain/entities";
import type { EventId, PadId } from "../../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";

/**
 * Pure, framework-free model for the CLP-02 step editor.
 *
 * The component (`StepEditor.tsx`) owns pointer state, gestures, and command
 * dispatch; everything that is a *function of the clip and instrument* lives
 * here so it can be unit-tested without a DOM. Nothing in this module mutates a
 * project — it only reads a clip's note content and the owning track's
 * instrument to describe the grid.
 */

/** A 16th note is the grid's fixed resolution (PRD CLP-02, 192 PPQ). */
export const STEPS_PER_BAR = TICKS_PER_BAR / TICKS_PER_SIXTEENTH;

/** The clip-length range CLP-02 supports, in bars — the domain's bound. */
export const MIN_BARS = MIN_CLIP_LENGTH_BARS;
export const MAX_BARS = MAX_CLIP_LENGTH_BARS;

/**
 * One row of the grid. A drum-machine clip shows one lane per pad, named after
 * the pad; a sampler clip shows a single pitched lane. `trigger` is what a note
 * painted into this lane fires.
 */
export interface StepLane {
  readonly key: string;
  readonly name: string;
  readonly trigger: NoteTrigger;
}

/**
 * How many bars the clip spans, clamped to the supported range. A clip whose
 * `lengthTicks` is not a whole number of bars rounds up to the next bar so no
 * step is hidden.
 */
export function barCount(clip: Clip): number {
  const bars = Math.ceil(clip.lengthTicks / TICKS_PER_BAR);
  return Math.min(MAX_BARS, Math.max(MIN_BARS, bars));
}

/**
 * The bar lengths the length control offers: the musical list (1/2/4/8/16/32)
 * rather than every integer, which at 32 bars would be an unusable dropdown.
 * A clip already sitting at an unlisted length keeps its own value in the list
 * so the control shows what the clip actually is instead of rendering blank.
 */
export function barOptions(clip: Clip): number[] {
  const current = barCount(clip);
  return CLIP_LENGTH_BARS.includes(current)
    ? [...CLIP_LENGTH_BARS]
    : [...CLIP_LENGTH_BARS, current].sort((a, b) => a - b);
}

/** Total 16th-note steps across the clip's bars. */
export function stepCount(clip: Clip): number {
  return barCount(clip) * STEPS_PER_BAR;
}

/** The absolute start tick of a step index (0-based). */
export function stepStartTicks(step: number): number {
  return step * TICKS_PER_SIXTEENTH;
}

/** True at the first step of a bar (a heavier bar division). */
export function isBarStart(step: number): boolean {
  return step % STEPS_PER_BAR === 0;
}

/** True at the first step of a beat (a lighter beat division). */
export function isBeatStart(step: number): boolean {
  return step % (STEPS_PER_BAR / 4) === 0;
}

/**
 * True on the beats the grid shades: alternating groups of four steps, as the
 * piano roll draws them (#643).
 */
export function isShadedBeat(step: number): boolean {
  return Math.floor(step / (STEPS_PER_BAR / 4)) % 2 === 0;
}

/** Whether two triggers name the same lane (pitch value, or pad id). */
export function triggersMatch(a: NoteTrigger, b: NoteTrigger): boolean {
  if (a.kind === "pitch" && b.kind === "pitch") return a.pitch === b.pitch;
  if (a.kind === "pad" && b.kind === "pad") return a.padId === b.padId;
  return false;
}

/**
 * The lanes to render for a clip on a track carrying `instrument`.
 *
 * - A `drumMachine` instrument yields one named lane per pad, top pad first, so
 *   hits can be painted across multiple lanes (CLP-02).
 * - Any other instrument yields a single pitched lane. A sampler or synth
 *   note clip opens the piano roll instead (#496), so this is only the fallback
 *   for a track with no instrument; the pitch keeps a legacy kick on one lane.
 */
export const SAMPLER_LANE_PITCH = 36;

export function lanesFor(instrument: Instrument | null): readonly StepLane[] {
  if (instrument?.kind === "drumMachine") {
    return instrument.pads.map((pad) => ({
      key: pad.id,
      name: pad.name,
      trigger: { kind: "pad", padId: pad.id },
    }));
  }
  return [
    {
      key: `pitch:${SAMPLER_LANE_PITCH}`,
      name: "Notes",
      trigger: { kind: "pitch", pitch: SAMPLER_LANE_PITCH },
    },
  ];
}

/**
 * `next`, keeping each lane of `previous` that it repeats unchanged, and
 * `previous` itself when nothing changed (GRV-214). The instrument is read
 * again on every project revision, and the grid's rows are keyed by lane
 * object: a fresh object for the same pad remounts its row, and the step that
 * had keyboard focus leaves the page with it.
 */
export function reuseLanes(
  previous: readonly StepLane[] | undefined,
  next: readonly StepLane[],
): readonly StepLane[] {
  if (!previous) return next;
  const byKey = new Map(previous.map((lane) => [lane.key, lane]));
  const lanes = next.map((lane) => {
    const kept = byKey.get(lane.key);
    return kept && kept.name === lane.name && triggersMatch(kept.trigger, lane.trigger)
      ? kept
      : lane;
  });
  const same =
    lanes.length === previous.length &&
    lanes.every((lane, index) => lane === previous[index]);
  return same ? previous : lanes;
}

/**
 * The selected row: the lane keyed `key` (a pad id on a drum machine), or the
 * first lane when there is no such lane any more, or null with no lanes.
 */
export function selectedLane(
  lanes: readonly StepLane[],
  key: string | null,
): StepLane | null {
  return lanes.find((lane) => lane.key === key) ?? lanes[0] ?? null;
}

/** The clip's note events, or an empty list for non-note content. */
export function noteEventsOf(clip: Clip): readonly NoteEvent[] {
  return clip.content.kind === "notes" ? clip.content.events : [];
}

/**
 * The note occupying a given lane and step, if any. A step is "occupied" when a
 * note starts exactly on that step's tick and its trigger matches the lane.
 */
export function noteAt(clip: Clip, lane: StepLane, step: number): NoteEvent | undefined {
  const startTicks = stepStartTicks(step);
  return noteEventsOf(clip).find(
    (event) =>
      event.startTicks === startTicks && triggersMatch(event.trigger, lane.trigger),
  );
}

/**
 * The step index the playhead is currently over, or `null` when the playhead
 * sits outside the clip's range or playback is stopped. Wraps within the clip's
 * bars so a looped clip lights the correct step on each pass.
 */
export function playbackStep(
  clip: Clip,
  positionTicks: number,
  isPlaying: boolean,
): number | null {
  if (!isPlaying) return null;
  const total = stepCount(clip);
  if (total <= 0) return null;
  const step = Math.floor(positionTicks / TICKS_PER_SIXTEENTH);
  if (step < 0) return null;
  return step % total;
}

/** The `event_count_bucket` for a completed gesture (PRD OPS-02). */
export function eventCountBucket(count: number): BucketLabel<"event_count"> {
  return bucketOf("event_count", count);
}

/** A stable identity for a (lane, step) cell, for pointer-drag de-duplication. */
export function cellKey(lane: StepLane, step: number): string {
  return `${lane.key}#${step}`;
}

export type { EventId, PadId };
