import type { JSX } from "@solidjs/web";
import { type Accessor, Show } from "solid-js";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type { Clip, Project, Track } from "../../domain/entities";
import type { EventId, PadId } from "../../domain/ids";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";
import type { LoopClipEntry } from "../composition/editorViewModel";
import type { PianoRollActions } from "../pianoRoll/rollActions";
import LoopInfo from "../transport/LoopInfo";
import TrackClipEditor from "./TrackClipEditor";
import "./SequenceEditor.css";

export interface SequenceEditorProps {
  readonly clip: Clip;
  readonly track: Track;
  readonly project: Project;
  /** The clip takes the CLP-03 piano roll rather than the CLP-02 step grid. */
  readonly showPianoRoll: Accessor<boolean>;
  /** Set when the opened clip is a tempo-labelled audio loop (LOOP-006). */
  readonly loop: LoopClipEntry | null;
  readonly songTempo: number;
  readonly editorPlaybackStep: Accessor<number | null>;
  readonly selectedNoteIds: Accessor<readonly EventId[]>;
  readonly setSelectedNoteIds: (ids: readonly EventId[]) => void;
  readonly playheadTicks: number;
  readonly registerPianoRollActions: (actions: PianoRollActions | null) => void;
  /** Whether the transport is running, and how the roll's Play toggles it. */
  readonly playing?: boolean;
  onTogglePlay?(): void;
  /** Plays one pitch on the opened track, for the roll's preview. */
  audition?(pitch: number, velocity: number): void;
  /**
   * The opened drum track's selected pad, shared with the instrument view
   * (#643): the step grid's selected row reads and sets it.
   */
  readonly selectedPadId?: PadId | null;
  onSelectPad?(padId: PadId): void;
  /** Plays one pad on the opened track, as a row is picked. */
  auditionPad?(padId: PadId): void;
  /**
   * Opens the library to add a pad to the opened drum track (#947), from the
   * step grid's [+ Pad] row. Omitted, no row.
   */
  onAddPad?(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * The sequence view (`UI-002`): the selected clip's steps or notes, filling
 * the page, on `2`.
 *
 * `UI-001` opened this as a window over the arrangement; `UI-002` makes it a
 * view of its own, so it is a named region rather than a dialog and leaving it
 * is pressing another view's key, not closing anything. Its contexts stay its
 * own (`sequence_editor`): the transport, the note shortcuts and the view keys
 * all keep working while a producer programs.
 */
export default function SequenceEditor(props: SequenceEditorProps): JSX.Element {
  return (
    <section class="sequence-view" aria-label="Sequence editor">
      <header class="sequence-view-header">
        {/* The track's name, chosen by the user (ADR 0002 decision 2). */}
        <h2 class={`sequence-editor-title ${MASK_CONTENT}`}>{props.track.name}</h2>
      </header>
      <div class={["sequence-editor-body", { "with-roll": props.showPianoRoll() }]}>
        {/* An audio loop has no notes to program, so what it gets is what
              LOOP-006 always showed — the tempo it was recorded at, and how
              following the song tempo will treat it — *instead of* the step
              grid and its note transforms, which would offer to edit notes
              the clip does not have (#281). */}
        <Show
          when={props.loop}
          fallback={
            <TrackClipEditor
              clip={props.clip}
              showPianoRoll={props.showPianoRoll}
              instrument={props.track.instrument ?? null}
              dispatch={props.dispatch}
              beginGesture={props.beginGesture}
              editorPlaybackStep={props.editorPlaybackStep}
              selectedNoteIds={props.selectedNoteIds}
              setSelectedNoteIds={props.setSelectedNoteIds}
              project={props.project}
              playheadTicks={props.playheadTicks}
              registerPianoRollActions={props.registerPianoRollActions}
              playing={props.playing}
              onTogglePlay={() => props.onTogglePlay?.()}
              audition={(pitch, velocity) => props.audition?.(pitch, velocity)}
              selectedPadId={props.selectedPadId}
              onSelectPad={(padId) => props.onSelectPad?.(padId)}
              auditionPad={(padId) => props.auditionPad?.(padId)}
              onAddPad={props.onAddPad && (() => props.onAddPad?.())}
            />
          }
        >
          {(entry) => (
            <LoopInfo
              clip={entry().clip}
              asset={entry().asset}
              songTempo={props.songTempo}
            />
          )}
        </Show>
      </div>
    </section>
  );
}
