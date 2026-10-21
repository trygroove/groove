import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { Project } from "../../domain/entities";
import EmptyView, { type EmptyViewFix } from "../composition/EmptyView";
import * as model from "../composition/editorViewModel";
import type { EditorViewName } from "../composition/editorViews";
import type { EditingSurfaces } from "../composition/useEditingSurfaces";
import type { UseEditorSessionResult } from "../composition/useEditorSession";
import type { ProjectAudioControls } from "../composition/useProjectAudio";
import type { TrackSelection } from "../tracks/useTrackSelection";
import { selectedPadOf } from "./padSelection";
import SequenceEditor from "./SequenceEditor";

export interface SequencePaneProps {
  readonly project: Project;
  readonly audio: ProjectAudioControls;
  readonly session: UseEditorSessionResult;
  readonly selection: TrackSelection;
  readonly surfaces: EditingSurfaces;
  readonly songTempo: number;
  /** The [+ Pad] row's way to the Library, aimed at a new pad (#947). */
  onAddPad(): void;
  /** An empty screen's way out, named and keyed as the dock names it. */
  fix(view: EditorViewName): EmptyViewFix;
  onFix(view: EditorViewName): void;
}

/**
 * The sequence view (`UI-002`): the opened clip's steps or notes, or what to
 * do when no clip is opened.
 */
export default function SequencePane(props: SequencePaneProps): JSX.Element {
  return (
    <Show
      when={props.selection.opened()}
      fallback={
        <EmptyView
          view="sequence"
          title="No clip selected"
          body="Select a clip in the arrangement, then press 2 to edit its steps or notes."
          fixes={[props.fix("arrangement")]}
          onFix={(view) => props.onFix(view)}
        />
      }
    >
      {(open) => (
        <SequenceEditor
          clip={open().clip}
          track={open().track}
          project={props.project}
          showPianoRoll={props.surfaces.showPianoRoll}
          loop={model.loopEntryFor(props.project, open().clip)}
          songTempo={props.songTempo}
          editorPlaybackStep={props.surfaces.editorPlaybackStep}
          selectedNoteIds={props.surfaces.selectedNoteIds}
          setSelectedNoteIds={props.surfaces.setSelectedNoteIds}
          playheadTicks={props.audio.positionTicks()}
          registerPianoRollActions={props.surfaces.setPianoRollActions}
          playing={props.audio.isPlaying()}
          onTogglePlay={() => void props.audio.toggle()}
          audition={(pitch, velocity) =>
            void props.audio.auditionTrack(
              open().track.id,
              { kind: "pitch", pitch },
              model.AUDITION_DURATION_TICKS,
              velocity,
            )
          }
          selectedPadId={selectedPadOf(props.selection.padSelection(), open().track)}
          onSelectPad={(padId) => props.selection.selectPad(open().track.id, padId)}
          auditionPad={(padId) => void props.audio.auditionPad(open().track.id, padId)}
          onAddPad={() => props.onAddPad()}
          dispatch={props.session.dispatch}
          beginGesture={props.session.beginGesture}
        />
      )}
    </Show>
  );
}
