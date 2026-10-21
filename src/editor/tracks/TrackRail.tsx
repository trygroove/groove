import { For, type JSX, Show } from "@solidjs/web";
import type { Analytics } from "../../analytics/analytics";
import { HEADER_WIDTH_PX, ROW_METRICS } from "../../arrangement/ArrangementView";
import { RULER_HEIGHT_PX } from "../../arrangement/canvasRenderer";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type { Track } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import NewTrackButtons from "./NewTrackButtons";
import TrackHeader from "./TrackHeader";
import { previewOrder } from "./trackActions";
import type { NewTrackKindSpec } from "./trackCreation";
import type { TrackLevel } from "./trackLevels";
import { useTrackDrag } from "./useTrackDrag";
import "./trackDrag.css";
import "./TrackRail.css";

export interface TrackRailProps {
  readonly tracks: readonly Track[];
  readonly selectedTrackId: TrackId | null;
  /** The track the user chose on its header (#960), framed as Delete's. */
  readonly chosenTrackId?: TrackId | null;
  onSelect(trackId: TrackId): void;
  /** Moves a track to a display index, when the rail is dragged (#447). */
  onReorder?(trackId: TrackId, toIndex: number): void;
  /** Adds a track of the chosen kind; the buttons follow the last row (#495). */
  onAddTrack?(spec: NewTrackKindSpec): void;
  /** Opens the library on loops, beside the per-kind buttons. */
  onAddLoop?(): void;
  /** Deletes a track, when its header's trash button is pressed (#537). */
  onDelete?(trackId: TrackId): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Live post-fader level of a track, for its header's meter. */
  trackLevel?(trackId: TrackId): TrackLevel | null;
  readonly analytics?: Analytics;
}

/**
 * The instrument view's track rail (`UI-001`): every track in the project, down
 * the left edge, and which one you are looking at.
 *
 * The instrument view shows one track at a time, so it needs its own way to
 * move between them — the arrangement's header column and the mixer's strips
 * are both on other pages now. It reports the click and nothing else: selection
 * is one piece of state across all three views, held by the editor.
 *
 * A list rather than a row of buttons, because that is what it is: an ordered
 * set of the project's tracks, one of which is current. Each row is the same
 * `TrackHeader` the arrangement's column shows, at the same size and, less the
 * arrangement's toolbars, the same place (#447): switching views moves nothing.
 */
export default function TrackRail(props: TrackRailProps): JSX.Element {
  let list: HTMLDivElement | undefined;
  const indexOf = (trackId: TrackId) => props.tracks.findIndex((t) => t.id === trackId);
  // Drag a row up or down to reorder its track (#447), as the arrangement's
  // header column does, with the same controller and the same one-entry drop.
  const drag = useTrackDrag({
    axis: "y",
    zone: () => list,
    indexOf,
    onDrop: (trackId, toIndex) => props.onReorder?.(trackId, toIndex),
  });
  /** The rows as letting go now would leave them: the dragged track is drawn
   * where it would land; the project changes only on release. */
  const shown = () =>
    previewOrder(props.tracks, (track) => track.id === drag.dragging(), drag.target());

  return (
    <div
      ref={list}
      class="track-rail"
      /* The arrangement's own header metrics, not a second set of numbers
         that would drift from them: a track's row is the same size and the
         column the same width in both views (`UI-001`). */
      style={{
        "--track-row-height": `${ROW_METRICS.headerHeightPx}px`,
        "--track-column-width": `${HEADER_WIDTH_PX}px`,
        "--track-ruler-height": `${RULER_HEIGHT_PX}px`,
      }}
    >
      <ul class="track-rail-list" aria-label="Tracks">
        {/* Keyed on the id, not the track: every edit mints a new track object,
          and a row rebuilt mid-drag loses its fader under the pointer. */}
        <For each={shown()} keyed={(track) => track.id}>
          {(track) => (
            <li
              class={[
                "track-rail-item",
                { "track-dragging": drag.dragging() === track().id },
              ]}
              data-track-drag={props.onReorder ? track().id : undefined}
            >
              <TrackHeader
                track={track()}
                selected={props.selectedTrackId === track().id}
                chosen={
                  props.chosenTrackId === undefined
                    ? undefined
                    : props.chosenTrackId === track().id
                }
                onSelect={() => props.onSelect(track().id)}
                dispatch={props.dispatch}
                beginGesture={props.beginGesture}
                trackLevel={(trackId) => props.trackLevel?.(trackId) ?? null}
                onDragStart={(event) => {
                  if (props.onReorder) drag.begin(event, track().id);
                }}
                onDelete={props.onDelete ? () => props.onDelete?.(track().id) : undefined}
                surface="instrument"
                analytics={props.analytics}
              />
            </li>
          )}
        </For>
      </ul>
      {/* The same per-kind buttons the arrangement offers below its last
          track, in the place the next track's row would go (#495). Outside
          the list, as the arrangement keeps them: they are not a track, and a
          list item with its role taken away is not valid list content (#76). */}
      <Show when={props.onAddTrack}>
        {(onAdd) => (
          <div class="track-rail-add">
            <NewTrackButtons
              label="Add track"
              onAdd={onAdd()}
              onAddLoop={props.onAddLoop}
            />
          </div>
        )}
      </Show>
    </div>
  );
}
