import type { RawCommandInput } from "../../commands";
import {
  duplicateNotes,
  noteEventsOf,
  removeNotes,
  removePlacement,
  updateClip,
  updateNotes,
  updatePlacement,
} from "../../commands";
import { MAX_CLIP_LENGTH_TICKS } from "../../domain/clipLength";
import type { Clip, Placement, Project } from "../../domain/entities";
import type { IdFactory } from "../../domain/ids";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";

/**
 * The transform panel's clip-length actions, Double and Halve: each builds the
 * registered commands that change a clip's length, its notes and its
 * placements together, for the caller to run as one transaction.
 */

/**
 * Double (#647), as Ableton's Duplicate Loop: the clip becomes twice as long
 * and every note is copied into the new half, whatever is selected. The
 * clip's arrangement placements that showed its end stretch to match, so the
 * new half plays where the clip does.
 *
 * Three registered commands in one transaction, so it is one revision and one
 * undo step: the clip grows first, then the copies land inside it, then the
 * placements stretch over it.
 */

/** Whether the clip can double without passing the longest clip length. */
export function canDouble(clip: Clip): boolean {
  return clip.lengthTicks * 2 <= MAX_CLIP_LENGTH_TICKS;
}

/** The commands that double `clip`; the caller checks `canDouble` first. */
export function doubleClip(
  project: Project,
  clip: Clip,
  ids: IdFactory,
): readonly RawCommandInput[] {
  const length = clip.lengthTicks;
  return [
    updateClip(clip.id, { lengthTicks: toTicks(length * 2) }),
    duplicateNotes(ids, project, {
      clipId: clip.id,
      eventIds: null,
      offsetTicks: length,
    }),
    ...doublePlacementCommands(project, clip),
  ] as readonly RawCommandInput[];
}

/**
 * What happens to the clip's placements. Each one that showed the clip's end
 * grows by the clip's old length, so the new half plays where the clip does:
 *
 * - When the next placement on its track is a full linked copy of the same
 *   clip, starting right where it ends (a right-edge drag tiles those, #493),
 *   the two merge into one placement twice as long. Four one-bar tiles become
 *   two two-bar placements, so the region still plays the whole clip in turn.
 * - Otherwise it grows into free space, stopping at the next placement on its
 *   track: a track's placements never overlap.
 *
 * A looped placement already repeats the clip, and one that stops short of
 * the end shows only part of it, so both stay as they are.
 */
function doublePlacementCommands(project: Project, clip: Clip): RawCommandInput[] {
  const length = clip.lengthTicks;
  const all = project.song.placements;
  const showsEnd = (placement: Placement) =>
    placement.clipId === clip.id &&
    !placement.looped &&
    placement.clipOffsetTicks + placement.durationTicks >= length;
  const isFullTile = (placement: Placement) =>
    placement.clipId === clip.id &&
    !placement.looped &&
    placement.clipOffsetTicks === 0 &&
    placement.durationTicks === length;

  const commands: RawCommandInput[] = [];
  const merged = new Set<Placement["id"]>();
  const byStart = [...all].sort((a, b) => a.startTicks - b.startTicks);
  for (const placement of byStart) {
    if (merged.has(placement.id) || !showsEnd(placement)) continue;
    const end = placement.startTicks + placement.durationTicks;
    const next = byStart.find(
      (other) => other.trackId === placement.trackId && other.startTicks >= end,
    );
    if (next && next.startTicks === end && isFullTile(next) && !merged.has(next.id)) {
      merged.add(next.id);
      commands.push(
        removePlacement(next.id),
        updatePlacement(placement.id, {
          durationTicks: toTicks(placement.durationTicks + length),
        }),
      );
      continue;
    }
    const grown = Math.min(end + length, next?.startTicks ?? end + length);
    if (grown > end) {
      commands.push(
        updatePlacement(placement.id, {
          durationTicks: toTicks(grown - placement.startTicks),
        }),
      );
    }
  }
  return commands;
}

/**
 * Halve (#662), Double's counterpart: the clip becomes half as long and keeps
 * its first half. Notes that start in the second half are removed, and one
 * that crosses the midpoint is shortened to end there. The clip's arrangement
 * placements shrink to match, so the arrangement shows exactly the kept half.
 *
 * Registered commands in one transaction, so it is one revision and one undo
 * step: the notes are trimmed first, then the clip shrinks around them, then
 * the placements shrink over it.
 */

/** Whether the clip can halve without going under one bar. */
export function canHalve(clip: Clip): boolean {
  return clip.lengthTicks / 2 >= TICKS_PER_BAR;
}

/** The commands that halve `clip`; the caller checks `canHalve` first. */
export function halveClip(project: Project, clip: Clip): readonly RawCommandInput[] {
  const half = clip.lengthTicks / 2;
  const events = noteEventsOf(clip) ?? [];
  const dropped = events.filter((event) => event.startTicks >= half);
  const crossing = events.filter(
    (event) => event.startTicks < half && event.startTicks + event.durationTicks > half,
  );
  return [
    ...(dropped.length > 0
      ? [
          removeNotes(
            clip.id,
            dropped.map((event) => event.id),
          ),
        ]
      : []),
    ...(crossing.length > 0
      ? [
          updateNotes(
            clip.id,
            crossing.map((event) => ({
              eventId: event.id,
              changes: { durationTicks: toTicks(half - event.startTicks) },
            })),
          ),
        ]
      : []),
    updateClip(clip.id, { lengthTicks: toTicks(half) }),
    ...halvePlacementCommands(project, clip, half),
  ] as readonly RawCommandInput[];
}

/**
 * A placement that showed past the new end now ends at it, and one that
 * showed only the removed half is removed. A looped placement keeps its
 * length and repeats the shorter clip.
 */
function halvePlacementCommands(
  project: Project,
  clip: Clip,
  half: number,
): RawCommandInput[] {
  return project.song.placements.flatMap((placement): RawCommandInput[] => {
    if (placement.clipId !== clip.id || placement.looped) return [];
    if (placement.clipOffsetTicks >= half) return [removePlacement(placement.id)];
    const shown = half - placement.clipOffsetTicks;
    return placement.durationTicks > shown
      ? [updatePlacement(placement.id, { durationTicks: toTicks(shown) })]
      : [];
  });
}
