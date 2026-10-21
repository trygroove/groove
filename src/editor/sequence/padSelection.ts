import type { Track } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";

/**
 * Which drum pad each drum track has selected (#643): UI-only, session-local,
 * and never in the project, like every selection (PRD 9.2).
 *
 * One selection, shared by the instrument view's pad editor and the step
 * grid's selected row, so picking either picks the other. It is held per track
 * so moving between drum tracks does not lose each one's pad.
 */
export type PadSelection = ReadonlyMap<TrackId, PadId>;

export const emptyPadSelection: PadSelection = new Map();

/** The selection with `padId` chosen on `trackId`. */
export function withSelectedPad(
  selection: PadSelection,
  trackId: TrackId,
  padId: PadId,
): PadSelection {
  if (selection.get(trackId) === padId) return selection;
  return new Map(selection).set(trackId, padId);
}

/**
 * The pad `track` has selected, when it still has it. A pad the track has lost
 * (deleted, undone, a remote edit) reads as its first pad, and a track with no
 * drum machine, or no pads, has none.
 */
export function selectedPadOf(
  selection: PadSelection,
  track: Track | null,
): PadId | null {
  if (track?.instrument?.kind !== "drumMachine") return null;
  const pads = track.instrument.pads;
  const chosen = selection.get(track.id);
  return pads.find((pad) => pad.id === chosen)?.id ?? pads[0]?.id ?? null;
}
