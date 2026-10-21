import { type Accessor, createMemo, createSignal, type Setter } from "solid-js";
import type { PlacementEditingActions } from "../../arrangement/ArrangementView";
import type { Clip } from "../../domain/entities";
import type { EventId } from "../../domain/ids";
import type { PianoRollActions } from "../pianoRoll/rollActions";
import { deleteSelectedNotes } from "../sequence/StepEditor";
import {
  noteEventsOf,
  playbackStep as playbackStepOf,
} from "../sequence/stepEditorModel";
import * as model from "./editorViewModel";
import type { UseEditorSessionResult } from "./useEditorSession";
import type { ProjectAudioControls } from "./useProjectAudio";

export interface UseEditingSurfacesOptions {
  /** The clip the sequence view edits, with its track, or null. */
  readonly opened: Accessor<model.OpenedClip | null>;
  readonly audio: Pick<ProjectAudioControls, "positionTicks" | "isPlaying">;
  readonly session: Pick<UseEditorSessionResult, "dispatch">;
}

export interface EditingSurfaces {
  /** The piano roll's operations, handed up while it is mounted. */
  readonly pianoRollActions: Accessor<PianoRollActions | null>;
  readonly setPianoRollActions: Setter<PianoRollActions | null>;
  /** The arrangement's placement-editing operations (ARR-002), likewise. */
  readonly arrangementEditingActions: Accessor<PlacementEditingActions | null>;
  readonly setArrangementEditingActions: Setter<PlacementEditingActions | null>;
  /** Whether the ruler's loop brace has keyboard focus (`LOOP-018`). */
  readonly loopBraceFocused: Accessor<boolean>;
  readonly setLoopBraceFocused: Setter<boolean>;
  /** Whether the arrangement's clip list has keyboard focus (#76). */
  readonly clipListFocused: Accessor<boolean>;
  readonly setClipListFocused: Setter<boolean>;
  /** The step editor's note selection (CLP-02). */
  readonly selectedNoteIds: Accessor<readonly EventId[]>;
  readonly setSelectedNoteIds: Setter<readonly EventId[]>;
  /** The clip being programmed: the opened one, not the selection's. */
  readonly clip: Accessor<Clip | null>;
  /** Which 16th step of that clip the playhead is passing, or null when stopped. */
  readonly editorPlaybackStep: Accessor<number | null>;
  /** Whether that clip is edited on the piano roll rather than the step grid. */
  readonly showPianoRoll: Accessor<boolean>;
  /** Deletes the step editor's selected notes. */
  deleteSelection(): void;
  /** The step grid's Select all (#835), or undefined with no clip open. */
  selectAllSteps(): (() => void) | undefined;
  /** Whether the arrangement holds a placement selection right now. */
  hasArrangementSelection(): boolean;
}

/**
 * What the editing surfaces hand up so the KEY-01 registry, not each surface,
 * can dispatch their edits: the piano roll's and the arrangement's
 * operations, the loop brace's focus, and the step editor's note selection,
 * with the clip they all edit.
 */
export function useEditingSurfaces(options: UseEditingSurfacesOptions): EditingSurfaces {
  const { opened, audio, session } = options;

  // The piano roll owns its own note selection, but the KEY-01 registry — not
  // the roll — dispatches delete/duplicate/select-all. The roll hands its
  // operations up through `registerActions`; this holds them so the shortcut
  // handlers can call them.
  const [pianoRollActions, setPianoRollActions] = createSignal<PianoRollActions | null>(
    null,
  );
  // The arrangement's placement-editing controller (ARR-002), lifted here the
  // same way so the KEY-01 registry — not the arrangement view — dispatches
  // cut/copy/paste/delete/duplicate.
  const [arrangementEditingActions, setArrangementEditingActions] =
    createSignal<PlacementEditingActions | null>(null);
  // Whether the ruler's loop brace has keyboard focus, lifted so the registry's
  // `loop_brace` context can follow it (`LOOP-018`).
  const [loopBraceFocused, setLoopBraceFocused] = createSignal(false);
  // Whether the arrangement's clip list has keyboard focus, so the registry's
  // `clip_list` context can follow it (#76).
  const [clipListFocused, setClipListFocused] = createSignal(false);
  // The step editor's note selection, lifted here so the `edit.delete` shortcut
  // can remove the same notes the grid shows highlighted (PRD KEY-01/CLP-02).
  const [selectedNoteIds, setSelectedNoteIds] = createSignal<readonly EventId[]>([]);

  /** The clip being programmed: the opened one, not the selection's. */
  const clip = createMemo(() => opened()?.clip ?? null);

  // The step editor's live playback-step indicator (CLP-02): which 16th step of
  // the edited clip the playhead is currently passing, wrapped within the clip's
  // bars, or null when stopped.
  const editorPlaybackStep = createMemo(() => {
    const currentClip = clip();
    if (!currentClip) return null;
    return playbackStepOf(currentClip, audio.positionTicks(), audio.isPlaying());
  });

  function deleteSelection(): void {
    const currentClip = clip();
    if (!currentClip) return;
    deleteSelectedNotes(currentClip, selectedNoteIds(), session.dispatch);
    setSelectedNoteIds([]);
  }

  /** The step grid's Select all (#835): every note in the open clip. */
  function selectAllSteps(): (() => void) | undefined {
    const currentClip = clip();
    if (!currentClip) return undefined;
    return () => setSelectedNoteIds(noteEventsOf(currentClip).map((note) => note.id));
  }

  const showPianoRoll = createMemo(() =>
    model.showPianoRoll(opened()?.track ?? null, clip()),
  );

  // Plain function, not a memo: `hasSelection()` reads the controller's
  // internal (non-signal) state, so this must be re-evaluated live on every
  // call — the same reason `pianoRollActions()?.hasSelection()` is called
  // directly rather than memoized elsewhere.
  //
  // Deliberately *not* gated on `showPianoRoll()` (#258). `showPianoRoll()`
  // says which editor is mounted *below* the arrangement, not which surface
  // has focus, and the arrangement is on screen either way — so gating on it
  // made a placement selected on a synth track invisible to the shortcut
  // layer and undeletable. Which surface a selection-scoped shortcut acts on
  // is `useEditorShortcuts`' to decide, from the selections that exist.
  const hasArrangementSelection = (): boolean =>
    arrangementEditingActions()?.hasSelection() ?? false;

  return {
    pianoRollActions,
    setPianoRollActions,
    arrangementEditingActions,
    setArrangementEditingActions,
    loopBraceFocused,
    setLoopBraceFocused,
    clipListFocused,
    setClipListFocused,
    selectedNoteIds,
    setSelectedNoteIds,
    clip,
    editorPlaybackStep,
    showPianoRoll,
    deleteSelection,
    selectAllSteps,
    hasArrangementSelection,
  };
}
