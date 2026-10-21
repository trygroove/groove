import type { Analytics } from "../../analytics/analytics";
import {
  type RawCommandInput,
  reorderTrack,
  type TransactionResult,
} from "../../commands";
import type { Project } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";

/**
 * Moving a track to a new position (TRK-02, #331), from whichever view the
 * producer is in. Every route — a drag in the arrangement's header column, a
 * drag along the mixer's strips, a move-left/right press — ends here, so each
 * is one `track.reorder` command, one revision, one history entry, and one
 * `track_reordered` event, and none of them is a second way to mutate order.
 */
export type ReorderView = "arrangement" | "mixer" | "instrument";
export type ReorderMethod = "drag" | "button" | "keyboard";

export interface TrackReorderContext {
  project(): Project | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  readonly analytics: Analytics;
}

/** The track ids in display order — `order`, not array position. */
export function orderedTrackIds(project: Project): TrackId[] {
  return [...project.song.tracks].sort((a, b) => a.order - b.order).map((t) => t.id);
}

/**
 * Move `trackId` to `toIndex` in display order. A move that would leave the
 * track where it is — or that names a track or position that does not exist —
 * dispatches nothing and logs nothing, so an abandoned drag is not an edit.
 */
export function moveTrack(
  context: TrackReorderContext,
  trackId: TrackId,
  toIndex: number,
  via: { view: ReorderView; method: ReorderMethod },
): boolean {
  const project = context.project();
  if (!project) return false;
  const ids = orderedTrackIds(project);
  const from = ids.indexOf(trackId);
  if (from < 0 || toIndex === from || toIndex < 0 || toIndex >= ids.length) {
    return false;
  }
  const result = context.dispatch(reorderTrack(trackId, toIndex));
  if (!result?.ok) return false;
  context.analytics.log("track_reordered", via);
  return true;
}

/**
 * The gap a dragged pointer is over, as an insertion slot `0..n`: slot `k`
 * sits before the item at `k`. `midpoints` are each item's centre along the
 * drag axis, in display order; the pointer is past an item once it crosses
 * that item's middle, the way every list reorder reads.
 */
export function dropSlot(pointer: number, midpoints: readonly number[]): number {
  let slot = 0;
  while (slot < midpoints.length && pointer > midpoints[slot]) slot += 1;
  return slot;
}

/**
 * The `toIndex` that dropping item `fromIndex` into `slot` means. The two
 * slots either side of the dragged item both leave it in place.
 */
export function slotToIndex(fromIndex: number, slot: number): number {
  return slot > fromIndex ? slot - 1 : slot;
}

/**
 * `items` as they would read with the one `isMoving` picks at `toIndex`, for
 * a drag's preview: the arrangement's rows, the rail's and the mixer's strips
 * all draw a drag this way. Unchanged when nothing is moving.
 */
export function previewOrder<T>(
  items: readonly T[],
  isMoving: (item: T) => boolean,
  toIndex: number | null,
): readonly T[] {
  if (toIndex === null) return items;
  const moving = items.find(isMoving);
  if (moving === undefined) return items;
  const rest = items.filter((item) => item !== moving);
  return [...rest.slice(0, toIndex), moving, ...rest.slice(toIndex)];
}

/** The project as it would read with `trackId` at `toIndex`, for a drag's preview:
 * only `order` changes, and nothing is dispatched. */
export function previewTrackOrder(
  project: Project,
  trackId: TrackId,
  toIndex: number,
): Project {
  const current = orderedTrackIds(project);
  if (!current.includes(trackId)) return project;
  const ids = previewOrder(current, (id) => id === trackId, toIndex);
  const tracks = project.song.tracks.map((track) => ({
    ...track,
    order: ids.indexOf(track.id),
  }));
  return { ...project, song: { ...project.song, tracks } };
}
