import type { Accessor } from "solid-js";
import type { Analytics } from "../analytics/analytics";
import type { Project } from "../domain/entities";
import type { PlacementId } from "../domain/ids";
import { focusKeepsKey, SOUNDS_KEY_ACTIONS } from "../library/soundKeys";
import {
  type ShortcutContext,
  type ShortcutHandlers,
  shortcutLabel,
  useShortcuts,
} from "../shortcuts";
import { ASK_OPTION_SHORTCUT_IDS } from "../shortcuts/registry/assistant";
import { isTextEntry } from "../shortcuts/textEntry";
import { arrangementHasFocus } from "./arrangementFocus";
import { RESIZE_STEP, RESIZE_STEP_LARGE } from "./assistant/assistantPanelLayout";
import type { AskDraft } from "./assistant/useAssistantChat";
import type { AssistantPanel } from "./assistant/useAssistantPanel";
import * as model from "./editorViewModel";
import type { EditorViewName } from "./editorViews";
import type { LibraryActions } from "./LibraryModal";
import type { PianoRollActions } from "./pianoRoll/rollActions";
import { deleteTrack, type TrackDeletionContext } from "./trackDeletion";
import type { EditingSurfaces } from "./useEditingSurfaces";
import type { EditorNavigation } from "./useEditorNavigation";
import type { UseEditorSessionResult } from "./useEditorSession";
import type { LibraryTargeting } from "./useLibraryTarget";
import type { ProjectAudioControls } from "./useProjectAudio";
import type { SongControls } from "./useSongControls";
import type { TrackSelection } from "./useTrackSelection";
import { focusedValueField } from "./valueFieldFocus";

export interface UseEditorShortcutsOptions {
  /** The view on screen, which comes from the URL (`UI-001`). */
  readonly view: Accessor<EditorViewName>;
  readonly project: Accessor<Project | null>;
  readonly audio: ProjectAudioControls;
  readonly session: UseEditorSessionResult;
  readonly analytics: Accessor<Analytics>;
  readonly navigation: EditorNavigation;
  readonly selection: TrackSelection;
  readonly library: LibraryTargeting;
  readonly song: SongControls;
  readonly surfaces: EditingSurfaces;
  /** Selects a placement's clip and goes to the sequence view with it. */
  readonly openPlacement: (placementId: PlacementId) => void;
  readonly guideOpen: Accessor<boolean>;
  readonly setGuideOpen: (open: boolean) => void;
  /** Whether the Export dialog is open (`EXP-004`): a modal, so it takes the keyboard. */
  readonly exportOpen: Accessor<boolean>;
  /** The assistant panel (#849): Cmd/Ctrl+K, Escape inside it, its
   * resize edge's arrows, Enter in its composer (GRV-26), and the keys of a
   * question it asks (GRV-42). */
  readonly assistant: Pick<
    AssistantPanel,
    | "toggle"
    | "resizeBy"
    | "dismissAction"
    | "edgeHasFocus"
    | "composerHasFocus"
    | "askTextHasFocus"
    | "focusInPanelOutsideFields"
  >;
  /** Sends the assistant composer's draft (GRV-26). */
  readonly sendAssistantDraft: () => void;
  /** The answer to a question the assistant asks, when one waits (GRV-42). */
  readonly assistantAsk: Pick<
    AskDraft,
    "pick" | "canFinish" | "finish" | "focused" | "canHear" | "hear"
  > & {
    readonly pending: () => boolean;
    /** How many options the pending question has; 0 with none waiting. */
    readonly optionCount: () => number;
    /** Whether the pending question takes several options. */
    readonly multiSelect: () => boolean;
  };
}

/** Controls that use the vertical arrows themselves, so a track step must not
 * steal them while one has focus (text entry is already left alone). */
const OWN_ARROWS =
  'input[type="range"], [role="slider"], [role="listbox"], [role="menu"]';
const focusKeepsArrows = (): boolean =>
  document.activeElement?.matches(OWN_ARROWS) ?? false;

/**
 * Installs the editor's PRD `KEY-01` shortcut mapping: which actions this
 * slice implements, what each does, and which contexts are active.
 *
 * Split out of `EditorView` (`REFACTOR-001`) as a plain function of the
 * editor's own hooks (#1035): its navigation, track selection, Library
 * target, song controls and editing surfaces, taken whole rather than as
 * loose callbacks, so the rules a key follows (which track the arrows step
 * to, which track Delete may remove) live here — not a registration seam a
 * panel contributes to. The issue's suggested "panel
 * registers its own context/handlers" seam would need each panel to publish
 * handlers the shortcut controller aggregates, which is a real architecture
 * change (today nothing but `EditorView` calls `useShortcuts`, and every
 * handler here reaches into state — `pianoRollActions`, `selectedNoteIds` —
 * that is lifted to this level for exactly that reason). Building that
 * speculatively, with only one consumer, risks the "growing inline ladder"
 * this refactor exists to avoid in a different way. This module is still the
 * complete answer to "touches the parent only at a small seam": a future
 * panel's shortcut needs land here, in one file, instead of inside
 * `EditorView.tsx` itself.
 */
export function useEditorShortcuts(options: UseEditorShortcutsOptions) {
  const {
    view,
    project,
    audio,
    session,
    selection,
    guideOpen,
    setGuideOpen,
    exportOpen,
    assistant,
  } = options;
  const {
    showPianoRoll,
    pianoRollActions,
    selectedNoteIds,
    deleteSelection,
    selectAllSteps,
    arrangementEditingActions,
    hasArrangementSelection,
    loopBraceFocused,
    clipListFocused,
  } = options.surfaces;
  const { toggleLoop: toggleLooping, moveLoop, resizeLoop } = options.song;

  /** Whether the Library view (`UI-002`) is on screen. */
  const libraryOpen = options.library.isOpen;
  /** Where Enter goes once its insert has committed: the instrument. */
  const returnFromInsert = () => options.library.returnFromInsert("keyboard");
  /** The open library modal's actions (`LIB-010`), or null while it is closed. */
  const libraryActions = options.library.actions;
  // `1`-`5` reach the same `selectView` the dock does, so the two
  // entrypoints cannot drift into different states (CF-008).
  const selectView = (next: EditorViewName) =>
    options.navigation.selectView(next, "keyboard");
  /** Whether the sequence view (`UI-002`) is on screen with a clip in it. */
  const sequenceEditorOpen = () => view() === "sequence" && selection.opened() !== null;
  /** Opens the arrangement's one selected clip in the sequence view, for
   * `Enter` (`UI-002`): `undefined` unless exactly one clip is selected. */
  const openSelectedClip = () => {
    const ids = arrangementEditingActions()?.getSelection() ?? [];
    return ids.length === 1 ? () => options.openPlacement(ids[0]) : undefined;
  };
  /** The track selection's `-1`/`+1` step (`track.select_previous`/`_next`):
   * `undefined` when there is no track that way (the ends, or a view where the
   * arrows keep another meaning), so the key is left to the browser. The mixer
   * keeps the arrows: its strips are moved with them (#447). */
  const adjacentTrack = (by: -1 | 1) => {
    if (view() === "mixer") return undefined;
    const id = model.adjacentTrackId(project(), selection.selectedTrackId(), by);
    return id ? () => selection.chooseTrack(id) : undefined;
  };
  const trackDeletion: TrackDeletionContext = {
    project,
    dispatch: (commands) => session.dispatch(commands),
    select: selection.selectTrack,
    get analytics() {
      return options.analytics();
    },
  };
  /** Deletes the selected track (#537): `undefined` where a track is not the
   * selection. Backspace on the selected track works where its header's trash
   * button is: not the mixer, and not in the sequence view. Only a track the
   * user chose through its header (#960) — not the first-track fallback, and
   * not one a lane click, a clip click or a deleted clip left selected — so a
   * slip never takes a whole track. Nor in the instrument view's return mode,
   * where the track is not on screen at all (#386). */
  const deleteSelectedTrack = () => {
    const id = selection.deletableTrackId();
    if (view() === "mixer" || view() === "sequence" || id === null) return undefined;
    if (view() === "instrument" && selection.selectedReturn() !== null) return undefined;
    if (!project()?.song.tracks.some((candidate) => candidate.id === id))
      return undefined;
    return () => deleteTrack(trackDeletion, id);
  };
  /** Drops the user's choice of track (#960), so Delete no longer removes it:
   * `undefined` while no track is chosen. Escape and any Delete that removes
   * something inside the track call it. */
  const dropTrackChoice = () =>
    selection.deletableTrackId() === null ? undefined : selection.dropTrackChoice;

  /**
   * Which surface a selection-scoped edit acts on right now (#258).
   *
   * Precedence, not visibility: the piano roll takes it while it is showing
   * *and* holds a note selection, otherwise the arrangement's placement
   * selection wins, and the step editor's lifted note selection is the last
   * resort (only while its grid is the one showing). Asking "is the piano roll
   * showing?" first is what broke Delete — that answers which editor is
   * mounted below the arrangement, not which surface the user selected in, so
   * a placement selected on a synth track was routed to a piano roll with
   * nothing selected and the keypress did nothing.
   */
  type SelectionOwner = "piano_roll" | "arrangement" | "step_editor";
  const selectionOwner = (): SelectionOwner | null => {
    if (showPianoRoll() && (pianoRollActions()?.hasSelection() ?? false)) {
      return "piano_roll";
    }
    if (hasArrangementSelection()) return "arrangement";
    if (!showPianoRoll() && selectedNoteIds().length > 0) return "step_editor";
    return null;
  };

  /** The piano roll's operations while it is on screen, else null. */
  const roll = (): PianoRollActions | null =>
    showPianoRoll() ? pianoRollActions() : null;
  /** Whether the roll on screen has notes selected, for the note moves. */
  const rollHasSelection = (): boolean => roll()?.hasSelection() ?? false;

  /**
   * Which surface Delete acts on (#643). While the sequence editor is open its
   * note editor owns the key outright: Delete takes its selected notes or
   * steps, and with none selected does nothing, rather than reaching past it
   * to the clip or track it was opened on.
   */
  const deleteOwner = (): SelectionOwner | null => {
    if (!sequenceEditorOpen()) return selectionOwner();
    if (showPianoRoll()) return rollHasSelection() ? "piano_roll" : null;
    return selectedNoteIds().length > 0 ? "step_editor" : null;
  };
  /** A note move: enabled while the roll holds a selection (ARR-010). */
  const noteMove = (run: (actions: PianoRollActions) => void) => ({
    run: () => {
      const actions = roll();
      if (actions) run(actions);
    },
    isEnabled: rollHasSelection,
  });

  /** Whether the sequence editor is showing the step grid, not the roll. */
  const stepGridOpen = (): boolean => sequenceEditorOpen() && !showPianoRoll();

  /** Whether a clip is being dragged in the arrangement right now. */
  const arrangementDragging = (): boolean =>
    arrangementEditingActions()?.isDragging() ?? false;

  /**
   * Whether the arrangement has focus (#835): it is the view on screen (its
   * actions exist only while it is mounted), no sequence editor is open over
   * it, and focus is not in a text field, dialog or popover. Select all and
   * Escape act on its clips only then, whatever it has selected.
   */
  const arrangementFocused = (): boolean =>
    arrangementEditingActions() !== null &&
    !sequenceEditorOpen() &&
    arrangementHasFocus();

  /** Whether Escape has an arrangement selection to clear (#835). */
  const arrangementClearable = (): boolean =>
    arrangementFocused() &&
    !(arrangementEditingActions()?.isBanding() ?? false) &&
    arrangementEditingActions()?.getArrangementSelection() != null;

  /** Whether Escape has a chosen track to let go of (#960), outside a text field. */
  const trackChoiceDroppable = (): boolean =>
    dropTrackChoice() !== undefined && !isTextEntry(document.activeElement);

  // The KEY-01 registry owns every mapping; this component only says which
  // actions exist here and what they do. An action the slice does not
  // implement yet simply has no handler and never fires.
  const inLibrary = (run: (actions: LibraryActions) => void) => ({
    run: () => {
      const actions = libraryActions();
      if (actions) run(actions);
    },
    isEnabled: () => libraryActions() !== null,
  });
  // Enter and Space stand down for a focused control, which takes the key
  // itself (#860); otherwise they act on the selected sound and stop there.
  const onSelectedSound = (run: (actions: LibraryActions) => void) => ({
    ...inLibrary(run),
    isEnabled: () => libraryActions() !== null && !focusKeepsKey(),
  });

  /** One resize step on the assistant's focused edge (#849). */
  const resizeEdge = (by: number) => ({
    run: () => assistant.resizeBy(by),
    isEnabled: () => assistant.edgeHasFocus(),
  });

  const handlers = (): ShortcutHandlers => ({
    "transport.play_stop": { run: () => void audio.toggle() },
    // Shift+Space resumes from where playback last stopped, exactly as the
    // registry describes it — not a second play/stop toggle.
    "transport.continue": { run: () => void audio.continueFromStop() },
    "transport.metronome": { run: () => audio.toggleMetronome() },
    "transport.toggle_loop": { run: () => toggleLooping() },
    // The focused brace's keys (`LOOP-018`), live only in `loop_brace`.
    "arrangement.loop_move_earlier": { run: () => moveLoop(-1) },
    "arrangement.loop_move_later": { run: () => moveLoop(1) },
    "arrangement.loop_shorten": { run: () => resizeLoop(-1) },
    "arrangement.loop_lengthen": { run: () => resizeLoop(1) },
    // The focused clip list's arrows (#76), live only in `clip_list`.
    "arrangement.clip_previous": { run: () => arrangementEditingActions()?.stepClip(-1) },
    "arrangement.clip_next": { run: () => arrangementEditingActions()?.stepClip(1) },
    "arrangement.clip_extend_previous": {
      run: () => arrangementEditingActions()?.extendClip(-1),
    },
    "arrangement.clip_extend_next": {
      run: () => arrangementEditingActions()?.extendClip(1),
    },
    // The canvas's edge drag, a bar at a time (#76).
    "arrangement.clip_shorten": {
      run: () => arrangementEditingActions()?.resizeSelection("end", -1),
      isEnabled: () => hasArrangementSelection(),
    },
    "arrangement.clip_lengthen": {
      run: () => arrangementEditingActions()?.resizeSelection("end", 1),
      isEnabled: () => hasArrangementSelection(),
    },
    "arrangement.clip_start_earlier": {
      run: () => arrangementEditingActions()?.resizeSelection("start", -1),
      isEnabled: () => hasArrangementSelection(),
    },
    "arrangement.clip_start_later": {
      run: () => arrangementEditingActions()?.resizeSelection("start", 1),
      isEnabled: () => hasArrangementSelection(),
    },
    "edit.undo": {
      run: () => session.undo(),
      isEnabled: () => session.state.canUndo,
    },
    "edit.redo": {
      run: () => session.redo(),
      isEnabled: () => session.state.canRedo,
    },
    // Delete the selected notes/placements of whichever surface currently owns
    // a selection: the piano roll keeps its own and hands the operation up
    // through `registerActions` (CLP-03), the step editor's is lifted into this
    // component (CLP-02), and the arrangement's placement selection is lifted
    // the same way (ARR-002). Only fires when some surface's selection is
    // non-empty, so an empty-selection Delete leaves the browser default alone
    // (PRD KEY-02). The selected track is the last resort (#537): a selection
    // of notes or clips is more specific and keeps the key, so the track goes
    // only when nothing inside it is selected.
    "edit.delete": {
      run: () => {
        const owner = deleteOwner();
        if (owner === "piano_roll") pianoRollActions()?.deleteSelection();
        else if (owner === "arrangement") arrangementEditingActions()?.deleteSelection();
        else if (owner === "step_editor") deleteSelection();
        else if (!sequenceEditorOpen()) deleteSelectedTrack()?.();
        // Removing what was selected inside a track spends the key: the next
        // Delete must not fall through to the whole track (#960).
        if (owner !== null) dropTrackChoice()?.();
      },
      isEnabled: () =>
        deleteOwner() !== null ||
        (!sequenceEditorOpen() && deleteSelectedTrack() !== undefined),
    },
    // The views (UI-001, UI-002). No `isEnabled`: a view is always reachable —
    // one the selection does not fit shows its empty screen — and asking for
    // the one you are on is a no-op inside `selectView`.
    "view.show_arrangement": { run: () => selectView("arrangement") },
    "view.show_sequence": { run: () => selectView("sequence") },
    "view.show_instrument": { run: () => selectView("instrument") },
    "view.show_library": { run: () => selectView("library") },
    "view.show_mixer": { run: () => selectView("mixer") },
    // In the library, `?` lists the library's own keys rather than the guide (#813).
    "help.shortcut_guide": {
      run: () => {
        const actions = libraryActions();
        if (libraryOpen() && actions) actions.toggleKeys();
        else setGuideOpen(true);
      },
    },
    // Enter on the arrangement's one selected clip opens it (UI-002), the
    // keyboard's double-click. A focused button keeps its own Enter: the
    // controller stands the key down there (GRV-54).
    "arrangement.open_clip": {
      run: () => openSelectedClip()?.(),
      isEnabled: () => arrangementFocused() && openSelectedClip() !== undefined,
    },
    // Up/Down walk the selected track in the arrangement and instrument views.
    // Plain arrows only: Alt+Up/Down stay `device.move_*` (exact-modifier
    // matching), and a fader or list that has focus keeps its own arrows.
    "track.select_previous": {
      run: () => adjacentTrack(-1)?.(),
      isEnabled: () => !focusKeepsArrows() && adjacentTrack(-1) !== undefined,
    },
    "track.select_next": {
      run: () => adjacentTrack(1)?.(),
      isEnabled: () => !focusKeepsArrows() && adjacentTrack(1) !== undefined,
    },
    // Frames the arrangement's selection (#292), the toolbar button's twin.
    // The arrangement is on screen in every editor state, so this is live
    // whenever it has something to frame.
    "view.zoom_to_selection": {
      run: () => arrangementEditingActions()?.zoomToSelection(),
      isEnabled: () => arrangementEditingActions()?.canZoomToSelection() ?? false,
    },
    // The zoom group's twins (#494). No `isEnabled`: the actions are null while
    // no arrangement is mounted, and the handler then does nothing.
    "view.zoom_to_arrangement": {
      run: () => arrangementEditingActions()?.zoomToArrangement(),
    },
    "view.scroll_to_playhead": {
      run: () => arrangementEditingActions()?.scrollToPlayhead(),
    },
    "view.zoom_in": { run: () => arrangementEditingActions()?.zoomIn() },
    "view.zoom_out": { run: () => arrangementEditingActions()?.zoomOut() },
    // The library modal's own keys, live only in the `library` context.
    "library.all_sounds": inLibrary((a) => a.showView("all")),
    "library.favourites": inLibrary((a) => a.showView("favourites")),
    "library.browse_packs": inLibrary((a) => a.showView("packs")),
    // `L` favourites the selected sound, or takes it out (#815).
    "library.like": inLibrary((a) => a.like()),
    // Enter inserts and goes back to the instrument, as the Insert button
    // does; Shift+Enter inserts and stays, so another sound can be tried
    // (UI-002). Each insert is one history entry.
    "library.insert": onSelectedSound((a) => void a.insertSelected()),
    "library.insert_and_return": onSelectedSound((a) => {
      void a.insertSelected().then((committed) => committed && returnFromInsert());
    }),
    ...Object.fromEntries(
      SOUNDS_KEY_ACTIONS.map((id) => [id, inLibrary((a) => a.press(id))]),
    ),
    "library.audition": onSelectedSound((a) => a.press("library.audition")),
    "library.back": inLibrary((a) => a.back()),
    // Escape closes the innermost surface: the guide, then the library's keys
    // sheet (#813), then its genre menu (#874), then a query typed in the
    // library's search field (#877, only while that field has focus). Nothing
    // here compares a key — this is the registry's `view.close_surface`, like
    // every other close. A clip drag in flight is innermost of all: Escape cancels it (ARR-011). The
    // sequence and library views are views, not dialogs (UI-002), so Escape
    // does not leave them: a view key does. With focus in the assistant
    // (#849), Escape is the panel's: it minimises a floating panel and closes
    // a docked one, before the library view under it. With no surface open,
    // it clears the arrangement's selection (#835).
    "view.close_surface": {
      run: () => {
        const dismissAssistant = assistant.dismissAction();
        if (arrangementDragging()) arrangementEditingActions()?.cancelDrag();
        else if (guideOpen()) setGuideOpen(false);
        else if (dismissAssistant) dismissAssistant();
        else if (libraryOpen()) {
          const actions = libraryActions();
          if (!actions?.closeKeys() && !actions?.closeMenu()) {
            actions?.escapeSearch();
          }
        } else {
          arrangementEditingActions()?.clearSelection();
          // "No selection" means no track for Delete either (#960).
          dropTrackChoice()?.();
        }
      },
      // The Export dialog closes itself on Escape, and nothing beneath it should.
      isEnabled: () =>
        !exportOpen() &&
        (arrangementDragging() ||
          guideOpen() ||
          assistant.dismissAction() !== undefined ||
          libraryOpen() ||
          arrangementClearable() ||
          trackChoiceDroppable()),
    },
    // The assistant (#849): Cmd/Ctrl+K opens it where it was or closes it, and
    // the arrows on its focused resize edge step its size.
    "assistant.toggle": { run: () => assistant.toggle() },
    "assistant.grow": resizeEdge(RESIZE_STEP),
    "assistant.shrink": resizeEdge(-RESIZE_STEP),
    "assistant.grow_more": resizeEdge(RESIZE_STEP_LARGE),
    "assistant.shrink_more": resizeEdge(-RESIZE_STEP_LARGE),
    // Enter in the composer sends (GRV-26). It is the composer's whenever it
    // has focus, so an empty draft or a reply on its way swallows the key
    // rather than adding a line; Shift+Enter is not this mapping and adds one.
    "assistant.send": {
      run: () => {
        // A question's "something else" box sends its answer (GRV-42).
        if (assistant.askTextHasFocus()) options.assistantAsk.finish();
        else options.sendAssistantDraft();
      },
      isEnabled: () => assistant.composerHasFocus() || assistant.askTextHasFocus(),
    },
    // A question the assistant asks (GRV-42): `1`-`8` pick its options, and
    // Enter sends a multi-select's picks. Enter on any other button in the
    // panel (Dismiss, the header's) presses that button instead. A digit past
    // the last option is no option, so it is left alone.
    ...Object.fromEntries(
      ASK_OPTION_SHORTCUT_IDS.map((id, index) => [
        id,
        {
          run: () => void options.assistantAsk.pick(index),
          isEnabled: () => index < options.assistantAsk.optionCount(),
        },
      ]),
    ),
    // Space on a chip with a sound plays it (GRV-42). On the panel itself it
    // is still play/stop, which the question's context would otherwise take;
    // on any other button it presses that button.
    "assistant.ask_hear": {
      run: () => {
        const focused = options.assistantAsk.focused();
        if (focused !== null && options.assistantAsk.canHear(focused)) {
          options.assistantAsk.hear(focused);
        } else {
          void audio.toggle();
        }
      },
      isEnabled: () => {
        const focused = options.assistantAsk.focused();
        if (focused !== null) return options.assistantAsk.canHear(focused);
        return !(document.activeElement instanceof HTMLButtonElement);
      },
    },
    "assistant.ask_finish": {
      run: () => void options.assistantAsk.finish(),
      // Enter on a focused button presses that button, with one exception: a
      // multi-select's chip, where Enter sends the picks rather than toggling
      // it. A single choice's chip keeps Enter, so it picks that chip (with
      // any typed text) rather than sending the text alone.
      isEnabled: () => {
        const focused = document.activeElement;
        const onChip =
          focused instanceof HTMLButtonElement &&
          focused.classList.contains("assistant-ask-option");
        if (focused instanceof HTMLButtonElement && !onChip) return false;
        if (onChip && !options.assistantAsk.multiSelect()) return false;
        return options.assistantAsk.canFinish();
      },
    },
    // A focused Transform value field (ARR-010): ↑/↓ nudge it, in place of
    // the roll's note moves, which its context replaces.
    "value.nudge_up": {
      run: () => focusedValueField()?.nudge(1),
      isEnabled: () => focusedValueField() !== null,
    },
    "value.nudge_down": {
      run: () => focusedValueField()?.nudge(-1),
      isEnabled: () => focusedValueField() !== null,
    },
    // The piano roll's note moves (ARR-010): arrows step through the rows the
    // roll shows and through steps; Shift moves by octaves or changes length.
    "note.move_up": noteMove((actions) => actions.moveRows(-1)),
    "note.move_down": noteMove((actions) => actions.moveRows(1)),
    "note.octave_up": noteMove((actions) => actions.moveOctaves(1)),
    "note.octave_down": noteMove((actions) => actions.moveOctaves(-1)),
    "note.move_earlier": noteMove((actions) => actions.moveSteps(-1)),
    "note.move_later": noteMove((actions) => actions.moveSteps(1)),
    "note.shorten": noteMove((actions) => actions.resizeSteps(-1)),
    "note.lengthen": noteMove((actions) => actions.resizeSteps(1)),
    // The piano roll's remaining note operations, dispatched by the registry
    // (KEY-01), not by a listener the roll owns. Each is enabled only while the
    // roll is showing; duplicate additionally needs a selection.
    //
    // Cmd/Ctrl+D in the arrangement makes an *independent* copy (#493): a fork
    // the user can edit on its own. A linked copy is made by dragging a clip's
    // right edge past its end instead, so the two are different gestures and
    // neither needs a toolbar to state which will run.
    "edit.duplicate": {
      run: () => {
        const owner = selectionOwner();
        if (owner === "piano_roll") pianoRollActions()?.duplicateSelection();
        else if (owner === "arrangement")
          arrangementEditingActions()?.duplicate("independent");
      },
      isEnabled: () => {
        const owner = selectionOwner();
        return owner === "piano_roll" || owner === "arrangement";
      },
    },
    // Select all: the open piano roll's notes, as before; otherwise, with the
    // arrangement focused, every clip in the song (#835) — even with nothing
    // selected, so the browser never selects the page's text instead.
    // Select all acts on the open note editor, the roll or the step grid,
    // and otherwise on the focused arrangement's clips (#835).
    "edit.select_all": {
      run: () => {
        const actions = pianoRollActions();
        if (actions) actions.selectAll();
        else if (stepGridOpen()) selectAllSteps()?.();
        else arrangementEditingActions()?.selectAll();
      },
      isEnabled: () =>
        pianoRollActions() !== null ||
        (stepGridOpen() && selectAllSteps() !== undefined) ||
        arrangementFocused(),
    },
    // Cut and copy act on the piano roll's notes while it holds a selection
    // (ARR-010), and otherwise on the arrangement's clips (ARR-002) — whichever
    // editor is mounted below it (#258).
    "edit.cut": {
      run: () => {
        if (rollHasSelection()) roll()?.cut();
        else arrangementEditingActions()?.cut();
      },
      isEnabled: () => rollHasSelection() || hasArrangementSelection(),
    },
    "edit.copy": {
      run: () => {
        if (rollHasSelection()) roll()?.copy();
        else arrangementEditingActions()?.copy();
      },
      isEnabled: () => rollHasSelection() || hasArrangementSelection(),
    },
    "edit.paste": {
      // Copied notes paste into the roll on screen at its insert marker. Clips
      // paste at the arrangement selection's start (#292), or the playhead
      // when nothing is selected, gated on the clipboard alone (#258).
      run: () => {
        if (roll()?.hasClipboard()) roll()?.paste();
        else arrangementEditingActions()?.paste(audio.positionTicks());
      },
      isEnabled: () =>
        (roll()?.hasClipboard() ?? false) ||
        (arrangementEditingActions()?.getClipboard().length ?? 0) > 0,
    },
  });

  // The surfaces this slice actually shows. The guide filters against these,
  // so "shortcuts valid in the current context" means the editor underneath
  // rather than the modal covering it. The piano roll adds its own contexts:
  // `piano_roll` (where `edit.delete` lives) and `selection` (where
  // `edit.duplicate`/`edit.select_all` live). `arrangement` is added while the
  // arrangement holds a live placement selection, the same conditional pattern
  // `selection` already follows for the piano roll, so
  // cut/copy/paste/delete/duplicate never steal a keystroke from an editor
  // that has nothing selected.
  //
  // A point, an empty range or a held clipboard keeps it active too (#292):
  // each covers no clip, but paste still has somewhere to go. Cut clears the
  // clips it took, and a click in empty space sets a point, so gating on
  // covered clips alone left Mod+V dead after either. Every other arrangement
  // edit keeps its own `isEnabled` on covered clips, so none of them fires.
  //
  // So does the arrangement having focus (#835), where Select all has to work
  // with nothing selected at all.
  const arrangementContextLive = (): boolean => {
    const actions = arrangementEditingActions();
    return (
      hasArrangementSelection() ||
      arrangementFocused() ||
      (actions !== null &&
        (actions.getArrangementSelection() !== null || actions.getClipboard().length > 0))
    );
  };

  const editorContexts = (): readonly ShortcutContext[] => {
    // A focused value field takes the arrows from the note editors
    // (`DISJOINT_CONTEXTS`); its text keeps every other key anyway.
    const base: readonly ShortcutContext[] = focusedValueField()
      ? ["editor", "value_field"]
      : showPianoRoll()
        ? ["editor", "step_editor", "piano_roll", "selection"]
        : ["editor", "step_editor"];
    // A live placement selection makes the arrangement's own mappings active
    // whichever editor is mounted below it (#258), not only when that editor
    // happens to be the step grid.
    const withArrangement: readonly ShortcutContext[] = arrangementContextLive()
      ? [...base, "arrangement"]
      : base;
    // The sequence view is a view, never the `dialog` context: the transport,
    // the note shortcuts and the view keys all keep working while a producer
    // programs in it (`UI-001`, `UI-002`).
    const withSequence: readonly ShortcutContext[] = sequenceEditorOpen()
      ? [...withArrangement, "sequence_editor"]
      : withArrangement;
    const withGesture: readonly ShortcutContext[] = arrangementDragging()
      ? [...withSequence, "gesture"]
      : withSequence;
    const withLoopBrace: readonly ShortcutContext[] = loopBraceFocused()
      ? [...withGesture, "loop_brace"]
      : clipListFocused()
        ? [...withGesture, "clip_list"]
        : withGesture;
    // The assistant's focused resize edge takes the arrows (#849).
    return assistant.edgeHasFocus() ? [...withLoopBrace, "resize_edge"] : withLoopBrace;
  };

  /**
   * The assistant's composer, or a question's "something else" box, takes
   * Enter while it has focus (GRV-26, GRV-42); focus elsewhere in the panel,
   * while a question waits, takes the question's keys.
   */
  const withComposer = (base: readonly ShortcutContext[]): readonly ShortcutContext[] => {
    if (assistant.composerHasFocus() || assistant.askTextHasFocus()) {
      return [...base, "composer"];
    }
    if (options.assistantAsk.pending() && assistant.focusInPanelOutsideFields()) {
      return [...base, "assistant_ask"];
    }
    return base;
  };

  // While a modal is open it is the only active context, so nothing behind it
  // can fire — including playback and selection (PRD KEY-02).
  const contexts = (): readonly ShortcutContext[] => {
    if (guideOpen() || exportOpen()) return ["dialog"];
    // The Library view has keys of its own, and the view keys and undo with
    // them; the editor's transport and edits stand down while it is up.
    return withComposer(libraryOpen() ? ["library"] : editorContexts());
  };

  const shortcuts = useShortcuts({ handlers, contexts });
  const keyHint = (action: Parameters<typeof shortcutLabel>[0]) =>
    shortcutLabel(action, shortcuts.platform);

  return { shortcuts, editorContexts, keyHint };
}
