import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { NoteTrigger, Project } from "../../domain/entities";
import {
  type SampleSlotTargeting,
  SampleSlotTargetingContext,
} from "../../instrument/sampleSlotTargeting";
import type { ShortcutActionId } from "../../shortcuts";
import * as model from "../composition/editorViewModel";
import type { UseEditorSessionResult } from "../composition/useEditorSession";
import type { ProjectAudioControls } from "../composition/useProjectAudio";
import type { LibraryTargeting } from "../library/useLibraryTarget";
import { selectedPadOf } from "../sequence/padSelection";
import type { NewTrackKindSpec } from "../tracks/trackCreation";
import type { TrackSelection } from "../tracks/useTrackSelection";
import EditorInstrument from "./EditorInstrument";

export interface InstrumentPaneProps {
  readonly project: Project;
  readonly audio: ProjectAudioControls;
  readonly session: UseEditorSessionResult;
  readonly selection: TrackSelection;
  readonly library: LibraryTargeting;
  keyHint(action: ShortcutActionId): string;
  onAddTrack(spec: NewTrackKindSpec): void;
}

const AUDITION_PITCH = 60; // Middle C

/**
 * The instrument view (`UI-002`): the selected track's instrument, with every
 * sample slot showing where the Library is aimed.
 */
export default function InstrumentPane(props: InstrumentPaneProps): JSX.Element {
  const { selection, library, audio } = props;
  const { track, drumTrack, padSelection, selectPad } = selection;

  /** What every sample slot shows of the Library's aim (`UI-002`). */
  const slotTargeting: SampleSlotTargeting = {
    get keyLabel() {
      return props.keyHint("view.show_library");
    },
    isTarget: (slot) => library.isTarget(slot),
  };

  const sampleAssets = createMemo(() => model.sampleAssets(props.project));
  const instrument = createMemo(() => model.editedInstrument(track()));
  const instrumentPanelTrackId = createMemo(() => model.instrumentPanelTrackId(track()));
  function auditionInstrument(): void {
    const currentTrack = track();
    const currentInstrument = instrument();
    if (!currentTrack || !currentInstrument) return;
    const trigger: NoteTrigger =
      currentInstrument.kind === "drumMachine" && currentInstrument.pads.length > 0
        ? { kind: "pad", padId: currentInstrument.pads[0].id }
        : { kind: "pitch", pitch: AUDITION_PITCH };
    void audio.auditionTrack(
      currentTrack.id,
      trigger,
      model.AUDITION_DURATION_TICKS,
      0.9,
    );
  }

  const sampleName = createMemo(() => model.sampleName(props.project, track()));

  return (
    <SampleSlotTargetingContext value={slotTargeting}>
      <EditorInstrument
        project={props.project}
        track={track() ?? null}
        returnBus={selection.selectedReturn()}
        drumTrack={drumTrack() ?? null}
        sampleAssets={sampleAssets()}
        instrument={instrument()}
        instrumentTrackId={instrumentPanelTrackId()}
        sampleName={sampleName()}
        loadSample={(sample) => void library.drop(sample)}
        audition={auditionInstrument}
        auditionPad={(trackId, padId) => void audio.auditionPad(trackId, padId)}
        onBrowse={() => library.aim("slot")}
        onBrowsePad={(trackId, padId) => {
          selectPad(trackId, padId);
          library.aim("slot");
        }}
        onBrowseLoop={() => library.aim("slot")}
        watchPeaks={audio.watchAssetPeaks}
        watchTriggers={audio.watchTriggers}
        trackLevel={audio.trackLevel}
        onSelectTrack={selection.selectTrackFrom}
        chosenTrackId={selection.deletableTrackId()}
        selectedPadId={selectedPadOf(padSelection(), drumTrack() ?? null)}
        onSelectPad={selectPad}
        onAddTrack={(spec) => props.onAddTrack(spec)}
        onAddLoop={() => library.aim("slot", "new-track")}
        dispatch={props.session.dispatch}
        beginGesture={props.session.beginGesture}
      />
    </SampleSlotTargetingContext>
  );
}
