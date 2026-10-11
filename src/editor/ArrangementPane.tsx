import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import ArrangementView from "../arrangement/ArrangementView";
import type { Project } from "../domain/entities";
import type { PlacementId } from "../domain/ids";
import type { ArrangementBand, ArrangementSelection } from "../selection";
import NewTrackButtons from "./NewTrackButtons";
import type { NewTrackKindSpec } from "./trackCreation";
import type { EditingSurfaces } from "./useEditingSurfaces";
import type { UseEditorSessionResult } from "./useEditorSession";
import type { ProjectAudioControls } from "./useProjectAudio";
import type { TrackSelection } from "./useTrackSelection";

export interface ArrangementPaneProps {
  readonly project: Project;
  readonly audio: ProjectAudioControls;
  readonly session: UseEditorSessionResult;
  readonly selection: TrackSelection;
  readonly surfaces: EditingSurfaces;
  onOpenPlacement(placementId: PlacementId): void;
  /** The arrangement's own selection from its last visit, kept by the editor. */
  readonly initialSelection: ArrangementSelection | null;
  onSelectionChange(selection: ArrangementSelection | null): void;
  onAddTrack(spec: NewTrackKindSpec): void;
  onAddLoop(): void;
  /** What the assistant's question points at while an option is hovered (GRV-42). */
  highlight?(): readonly ArrangementBand[];
}

/** What the arrangement and the instrument view both show for an empty song. */
function NoTracks(): JSX.Element {
  return <p class="no-track">This project has no tracks yet. Add one in the mixer.</p>;
}

/** The arrangement view (`UI-001`): the song's tracks on the timeline. */
export default function ArrangementPane(props: ArrangementPaneProps): JSX.Element {
  return (
    <div class="editor-main">
      <div class="arrangement-panel">
        <ArrangementView
          project={props.project}
          playheadTicks={props.audio.positionTicks}
          isPlaying={props.audio.isPlaying}
          trackLevel={props.audio.trackLevel}
          dispatch={props.session.dispatch}
          beginGesture={props.session.beginGesture}
          onEditingActionsReady={props.surfaces.setArrangementEditingActions}
          selectedTrackId={props.selection.track()?.id ?? null}
          chosenTrackId={props.selection.deletableTrackId()}
          onSelectTrack={props.selection.selectTrackFrom}
          onOpenPlacement={props.onOpenPlacement}
          onSelectPlacement={props.selection.selectPlacement}
          initialSelection={props.initialSelection}
          onSelectionChange={(selected) => props.onSelectionChange(selected)}
          onLoopBraceFocusChange={props.surfaces.setLoopBraceFocused}
          onClipListFocusChange={props.surfaces.setClipListFocused}
          highlight={() => props.highlight?.() ?? []}
          /* The arrangement's own way to add a track (`UI-001`), the same unit
           and the same route the mixer uses — rendered by the arrangement
           directly below the last track, where the next one would go, rather
           than in a band above the timeline. */
          belowTracks={
            <NewTrackButtons
              label="Add track to the arrangement"
              onAdd={(spec) => props.onAddTrack(spec)}
              onAddLoop={() => props.onAddLoop()}
            />
          }
        />
      </div>
      <Show when={props.project.song.tracks.length === 0}>
        <NoTracks />
      </Show>
    </div>
  );
}
