import type { RawCommandInput } from "../../commands";
import {
  duplicateNotes,
  removePlacement,
  updateClip,
  updatePlacement,
} from "../../commands";
import { MAX_CLIP_LENGTH_TICKS } from "../../domain/clipLength";
import type { Clip, Placement, Project } from "../../domain/entities";
import type { IdFactory } from "../../domain/ids";
import { toTicks } from "../../domain/time";

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
    ...placementCommands(project, clip),
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
function placementCommands(project: Project, clip: Clip): RawCommandInput[] {
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
