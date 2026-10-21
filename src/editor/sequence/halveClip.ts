import type { RawCommandInput } from "../../commands";
import {
  noteEventsOf,
  removeNotes,
  removePlacement,
  updateClip,
  updateNotes,
  updatePlacement,
} from "../../commands";
import type { Clip, Project } from "../../domain/entities";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";

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
    ...placementCommands(project, clip, half),
  ] as readonly RawCommandInput[];
}

/**
 * A placement that showed past the new end now ends at it, and one that
 * showed only the removed half is removed. A looped placement keeps its
 * length and repeats the shorter clip.
 */
function placementCommands(
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
