import { type Accessor, createMemo, createSignal, Show } from "solid-js";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type { Clip, Instrument, Project } from "../../domain/entities";
import type { EventId, PadId } from "../../domain/ids";
import KeyPanel from "../pianoRoll/KeyPanel";
import PianoRoll from "../pianoRoll/PianoRoll";
import type { PianoRollActions } from "../pianoRoll/rollActions";
import { toggleTrackFlag } from "../tracks/trackSurface";
import GeneratePanel from "./GeneratePanel";
import { previewRow } from "./generatedRow";
import StepEditor from "./StepEditor";
import { lanesFor, noteEventsOf, selectedLane, triggersMatch } from "./stepEditorModel";
import type { Hit } from "./stepGenerators";
import TransformPanel from "./TransformPanel";
import type { TransformFallback } from "./transformModel";

export interface TrackClipEditorProps {
  /** The edited track's clip, or null when it has none yet (#228). */
  readonly clip: Clip | null;
  /** A synth or sampler note clip gets the piano roll; a drum machine, the grid. */
  readonly showPianoRoll: Accessor<boolean>;
  readonly instrument: Instrument | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  readonly editorPlaybackStep: Accessor<number | null>;
  readonly selectedNoteIds: Accessor<readonly EventId[]>;
  readonly setSelectedNoteIds: (ids: readonly EventId[]) => void;
  readonly project: Project;
  readonly playheadTicks: number;
  readonly registerPianoRollActions: (actions: PianoRollActions | null) => void;
  /** Whether the transport is running, and how the roll's Play toggles it. */
  readonly playing?: boolean;
  onTogglePlay?(): void;
  /** Plays one pitch on the track's instrument, for the roll's preview. */
  audition?(pitch: number, velocity: number): void;
  /** The step grid's selected row, shared with the drum machine (#643). */
  readonly selectedPadId?: PadId | null;
  onSelectPad?(padId: PadId): void;
  auditionPad?(padId: PadId): void;
  /** The step grid's [+ Pad] row on a drum machine (#947). */
  onAddPad?(): void;
}

/**
 * One track's clip, in whichever of the two editors it takes (the sequence
 * editor's title bar already names the track) — the `CLP-02` step grid, with the Transform panel
 * beneath, or the ARR-010 piano roll, with the Key and Transform panels side
 * by side beneath it.
 */
export default function TrackClipEditor(props: TrackClipEditorProps) {
  const trackOf = (clip: Clip) =>
    props.project.song.tracks.find((track) => track.id === clip.trackId);
  // The piano roll owns its own selection (the step editor's is lifted into
  // `EditorView`), and mirrors it out here for the Transform panel.
  const [rollSelection, setRollSelection] = createSignal<readonly EventId[]>([]);

  // The step grid's selected row (#643), which the Generate panel writes
  // into: the host's selected pad when it owns one, else held here.
  const [ownPad, setOwnPad] = createSignal<PadId | null>(null);
  const padId = () =>
    props.selectedPadId !== undefined ? props.selectedPadId : ownPad();
  function selectPad(id: PadId): void {
    setOwnPad(id);
    props.onSelectPad?.(id);
  }
  const row = createMemo(() => selectedLane(lanesFor(props.instrument), padId()));
  // With nothing selected, a transform acts on the active row only (#643).
  const rowScope = (clip: Clip): TransformFallback | null => {
    const target = row();
    if (!target) return null;
    const eventIds = noteEventsOf(clip)
      .filter((event) => triggersMatch(event.trigger, target.trigger))
      .map((event) => event.id);
    return { name: target.name, eventIds };
  };
  // What the hovered or focused generator would write, drawn in the grid.
  const [generated, setGenerated] = createSignal<readonly Hit[] | null>(null);
  const preview = (clip: Clip) => {
    const hits = generated();
    const target = row();
    return hits && target ? previewRow(clip, target.trigger, hits) : null;
  };

  return (
    <div class={["track-clip-editor", { "with-roll": props.showPianoRoll() }]}>
      {/*
       * A track carries no clip until one is placed on it — a track added
       * from the mixer starts empty (#228).
       */}
      <Show
        when={props.clip}
        fallback={<p class="no-clip">This track has no clip yet.</p>}
      >
        {(clip) => (
          <Show
            when={props.showPianoRoll()}
            fallback={
              <>
                <StepEditor
                  clip={clip()}
                  project={props.project}
                  instrument={props.instrument}
                  dispatch={props.dispatch}
                  beginGesture={props.beginGesture}
                  playbackStep={props.editorPlaybackStep}
                  playing={props.playing}
                  onTogglePlay={() => props.onTogglePlay?.()}
                  soloed={trackOf(clip())?.mixer.soloed ?? false}
                  onToggleSolo={() => {
                    const track = trackOf(clip());
                    if (track) toggleTrackFlag(props.dispatch, track, "soloed");
                  }}
                  selectedIds={props.selectedNoteIds}
                  setSelectedIds={props.setSelectedNoteIds}
                  selectedPadId={padId()}
                  onSelectPad={selectPad}
                  auditionPad={(id) => props.auditionPad?.(id)}
                  preview={preview(clip())}
                  onAddPad={props.onAddPad && (() => props.onAddPad?.())}
                />
                {/* Generate takes the Key panel's place beside Transform. */}
                <div class="roll-panels step-panels">
                  <GeneratePanel
                    clip={clip()}
                    row={row()}
                    dispatch={props.dispatch}
                    onPreview={setGenerated}
                  />
                  <TransformPanel
                    clip={clip()}
                    project={props.project}
                    selectedIds={props.selectedNoteIds()}
                    fallback={rowScope(clip())}
                    dispatch={props.dispatch}
                    editor="step"
                  />
                </div>
              </>
            }
          >
            <PianoRoll
              clip={clip()}
              project={props.project}
              dispatch={props.dispatch}
              beginGesture={props.beginGesture}
              playheadTicks={props.playheadTicks}
              playing={props.playing}
              onTogglePlay={() => props.onTogglePlay?.()}
              audition={(pitch, velocity) => props.audition?.(pitch, velocity)}
              registerActions={props.registerPianoRollActions}
              onSelectionChange={setRollSelection}
            />
            <div class="roll-panels">
              <KeyPanel musicalKey={props.project.song.key} dispatch={props.dispatch} />
              <TransformPanel
                clip={clip()}
                project={props.project}
                selectedIds={rollSelection()}
                dispatch={props.dispatch}
                editor="piano_roll"
              />
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}
