import type { Analytics } from "../../analytics/analytics";
import {
  type RawCommandInput,
  removeTrack,
  type TransactionResult,
} from "../../commands";
import type { Project } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import { orderedTrackIds } from "./trackReorder";

/**
 * Deleting a track (#537), from whichever surface asks: the header's trash
 * button in the arrangement and instrument views, or Backspace on the selected
 * track. Every route ends here, so each is one `track.delete` command through
 * the command layer — one revision, one undo entry, no confirmation, because
 * undo brings the track back with its clips, placements and automation.
 */
export interface TrackDeletionContext {
  project(): Project | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Points the editor at a track; the deleted one is already gone. */
  select(trackId: TrackId): void;
  readonly analytics: Analytics;
}

/**
 * The track to show once `trackId` is gone: the one after it in display order,
 * else the one before it, else none (it was the only track).
 */
export function neighbourTrackId(project: Project, trackId: TrackId): TrackId | null {
  const ids = orderedTrackIds(project);
  const index = ids.indexOf(trackId);
  if (index < 0) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** Whether `trackId` is a track the project holds (and so can be deleted). */
export function canDeleteTrack(
  project: Project | null,
  trackId: TrackId | null,
): boolean {
  return !!project && !!trackId && project.song.tracks.some((t) => t.id === trackId);
}

/** Deletes `trackId` and selects its neighbour; false when nothing changed. */
export function deleteTrack(context: TrackDeletionContext, trackId: TrackId): boolean {
  const project = context.project();
  if (!project || !canDeleteTrack(project, trackId)) return false;
  const neighbour = neighbourTrackId(project, trackId);
  const result = context.dispatch(removeTrack(trackId));
  if (!result?.ok) return false;
  if (neighbour) context.select(neighbour);
  context.analytics.logFeatureFirstUse("track_delete");
  return true;
}
