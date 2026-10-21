import type { RawCommandInput, TransactionResult } from "../../commands";
import { setTrackFlag } from "../../commands";
import type { Track } from "../../domain/entities";

/**
 * How a track came to be selected (#960). `"header"` is the user choosing it
 * on a track surface: its header, the track list, a mixer strip. `"follow"` is
 * the editor following along after something else: a lane or clip press, a
 * new track, the neighbour of a deleted one. Only a chosen track is Delete's.
 */
export type TrackSelectionSource = "header" | "follow";

export interface TrackSurfaceOptions {
  /** Whether the editor is showing this surface's track. */
  selected(): boolean;
  /** Points the editor at the track. */
  onSelect(): void;
  /** Starts a reorder drag, from a press anywhere but the controls. */
  onDragStart?(event: PointerEvent): void;
  /** What a press on starts no drag from: the surface's own controls. */
  readonly controls: string;
  /** What a click on does not select from: controls that act on their own. */
  readonly clickExempt: string;
}

/**
 * The handlers every track surface carries (#447), the mixer strip and the
 * track header alike: touching it selects its track, a click on it and any
 * value changed on it, and a press anywhere but its controls starts a drag.
 * The handlers bubble up after the controls' own, so nothing is swallowed.
 */
export function trackSurfaceHandlers(options: TrackSurfaceOptions) {
  const selectOnce = () => {
    if (!options.selected()) options.onSelect();
  };
  return {
    onPointerDown(event: PointerEvent): void {
      if (!(event.target as Element).closest(options.controls)) {
        options.onDragStart?.(event);
      }
    },
    onClick(event: MouseEvent): void {
      if (!(event.target as Element).closest(options.clickExempt)) selectOnce();
    },
    onInput: selectOnce,
    onChange: selectOnce,
  };
}

/** Flips a track's mute or solo, through the command layer. */
export function toggleTrackFlag(
  dispatch: (
    commands: RawCommandInput | readonly RawCommandInput[],
  ) => TransactionResult | undefined,
  track: Track,
  flag: "muted" | "soloed",
): void {
  dispatch(setTrackFlag(track.id, flag, !track.mixer[flag]));
}
