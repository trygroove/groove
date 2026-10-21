import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import type { Project, ReturnBus, Track } from "../../domain/entities";
import type { PadId, PlacementId, ReturnId, TrackId } from "../../domain/ids";
import {
  emptySelection,
  reconcileSelection,
  type SelectionState,
  selectOnly,
} from "../../selection";
import type { EditorLocation } from "../composition/editorControls";
import * as model from "../composition/editorViewModel";
import {
  emptyPadSelection,
  type PadSelection,
  withSelectedPad,
} from "../sequence/padSelection";
import type { TrackSelectionSource } from "./trackSurface";

/** What the editor is pointed at: everything in a location but the view. */
export type SelectionLocation = Omit<EditorLocation, "view">;

export interface UseTrackSelectionOptions {
  readonly project: Accessor<Project | null>;
  /**
   * Called each time the user points the editor at a track or a pad (not on a
   * reconcile or a restore), so state that only lasts until then can end.
   */
  readonly onPoint?: () => void;
}

export interface TrackSelection {
  /** The shared PRD 9.2 selection the editor is pointed at. */
  readonly selection: Accessor<SelectionState>;
  /** The selected track's id, or null with nothing selected. */
  readonly selectedTrackId: Accessor<TrackId | null>;
  /** The selected track, falling back to the project's first. */
  readonly track: Accessor<Track | null>;
  /** That track, if it carries a drum machine. */
  readonly drumTrack: Accessor<Track | null>;
  /** The selected track, if the user chose it (#960); else null. */
  readonly deletableTrackId: Accessor<TrackId | null>;
  /** Each drum track's selected pad (#643). */
  readonly padSelection: Accessor<PadSelection>;
  /** The placement whose clip the sequence view edits, as picked. */
  readonly openPlacementId: Accessor<PlacementId | null>;
  /** That clip, while its track is the selected track; else null. */
  readonly opened: Accessor<model.OpenedClip | null>;
  /** Points the editor at a track; `chosen` when the user chose it (#960). */
  selectTrack(trackId: TrackId, chosen?: boolean): void;
  /** Selects a track the user chose, so Delete may remove it. */
  chooseTrack(trackId: TrackId): void;
  /** Selects a track from a surface that says how it was picked. */
  selectTrackFrom(trackId: TrackId, how: TrackSelectionSource): void;
  /** Lets go of the user's choice of track, keeping it selected. */
  dropTrackChoice(): void;
  /** Selects a drum track's pad. */
  selectPad(trackId: TrackId, padId: PadId): void;
  /**
   * The return the mixer pointed the editor at (#386), while it is still in
   * the song; else null.
   */
  readonly selectedReturn: Accessor<ReturnBus | null>;
  /** Points the instrument view at a return's chain (#386). */
  selectReturn(returnId: ReturnId): void;
  /**
   * Lets go of the return (#1106), so the mixer's chain slot shows the
   * master's again and the instrument view goes back to the track.
   */
  selectMaster(): void;
  /** Makes a placement's clip the one `2` edits, and selects its track. */
  selectPlacement(placementId: PlacementId): void;
  /** Where the selection is now, for putting it back later. */
  location(): SelectionLocation;
  /** Puts the selection back where `location()` found it. */
  restore(location: SelectionLocation): void;
}

/**
 * Which track, pad and clip the editor is pointed at (#228, #643, `UI-002`).
 *
 * UI-only state held in the shared PRD 9.2 selection model — never in the
 * project — so one click moves the clip editor, the instrument panel, and the
 * device chain together. This hook is the one owner of every write to it:
 * the editor and its surfaces select through these functions, never by
 * setting the state themselves.
 */
export function useTrackSelection(options: UseTrackSelectionOptions): TrackSelection {
  const { project } = options;

  // Nothing is selected on arrival; `model.editedTrack` then falls back to the
  // project's first track.
  const [selection, setSelection] = createSignal<SelectionState>(emptySelection());
  // A track deleted by this session, an undo, or a remote edit must not leave
  // the editor pointed at it: `reconcileSelection` drops the dead scope, and
  // the fallback picks up from there.
  //
  // `project()` is the effect's only reactive read, so it is the whole compute
  // half; the `setSelection` write has to be in the apply half, which is the
  // only phase of an effect where a write is allowed.
  createEffect(
    () => project(),
    (current) => {
      if (!current) return;
      setSelection((state) => reconcileSelection(state, current));
    },
  );
  // Whether the user *chose* the selected track (#960): through its header,
  // the track list, the instrument rail, or the track arrows. Only a chosen
  // track is Delete's to remove. Every other way a track ends up selected — a
  // lane or clip click, opening a clip, a deleted neighbour, a new track —
  // only points the editor at it, and clears the choice.
  const [chosenTrackId, setChosenTrackId] = createSignal<TrackId | null>(null);
  // The return the mixer pointed the editor at (#386), which puts the
  // instrument view in return mode. UI-only like the track selection, and
  // beside it rather than in it: the arrangement and the step editor keep
  // following the track while a return's chain is open. Selecting any track
  // or the master clears it, and so does the return being deleted or undone away: the view
  // falls back to the track, and stays there when an undo brings the return
  // back.
  const [returnSelection, setReturnSelection] = createSignal<ReturnId | null>(null);
  const selectedReturn = createMemo(() => {
    const id = returnSelection();
    return id ? (project()?.song.returns.find((bus) => bus.id === id) ?? null) : null;
  });
  // Both reads in compute; the write is only legal in the apply half.
  createEffect(
    () => returnSelection() !== null && selectedReturn() === null,
    (stale) => {
      if (stale) setReturnSelection(null);
    },
  );
  function selectTrack(trackId: TrackId, chosen = false): void {
    options.onPoint?.();
    setReturnSelection(null);
    setSelection(selectOnly({ kind: "track", id: trackId }));
    setChosenTrackId(chosen ? trackId : null);
  }
  const chooseTrack = (trackId: TrackId) => selectTrack(trackId, true);
  const selectTrackFrom = (trackId: TrackId, how: TrackSelectionSource) =>
    selectTrack(trackId, how === "header");
  const selectedTrackId = createMemo(() => model.focusedTrackId(selection()));
  /** The selected track, if the user chose it; else null. */
  const deletableTrackId = createMemo(() => {
    const id = chosenTrackId();
    return id !== null && id === selectedTrackId() ? id : null;
  });

  // Which placement's clip the sequence view edits (`UI-001`, `UI-002`) — a
  // placement id, not a clip id: opening is a gesture on the timeline. It is
  // the selected clip only while its track is the selected track: choosing
  // another track leaves `2` with no clip, rather than on one the instrument
  // and mixer views have moved away from.
  const [openPlacementId, setOpenPlacementId] = createSignal<PlacementId | null>(null);
  const opened = createMemo(() => {
    const entry = model.openedClip(project(), openPlacementId());
    return entry && entry.track.id === selectedTrackId() ? entry : null;
  });

  /**
   * Makes a placement's clip the one `2` edits (`UI-002`): a click on a clip
   * in the arrangement selects it for the sequence view.
   */
  function selectPlacement(placementId: PlacementId): void {
    setOpenPlacementId(placementId);
    const track = model.openedClip(project(), placementId)?.track;
    // Selecting a clip is also saying "this track": the instrument view and the
    // mixer follow it, which is what keeps selection one piece of state.
    if (track) selectTrack(track.id);
  }

  const track = createMemo(() => model.editedTrack(project(), selectedTrackId()));
  const drumTrack = createMemo(() => model.drumTrack(track()));
  // Each drum track's selected pad (#643): one selection the instrument view's
  // pad editor and the step grid's selected row share, held here so it
  // outlives a switch of view.
  const [padSelection, setPadSelection] = createSignal<PadSelection>(emptyPadSelection);
  function selectPad(trackId: TrackId, padId: PadId): void {
    options.onPoint?.();
    setPadSelection((current) => withSelectedPad(current, trackId, padId));
  }

  return {
    selection,
    selectedTrackId,
    track,
    drumTrack,
    deletableTrackId,
    padSelection,
    openPlacementId,
    opened,
    selectTrack,
    chooseTrack,
    selectTrackFrom,
    dropTrackChoice: () => setChosenTrackId(null),
    selectPad,
    selectedReturn,
    selectReturn: (returnId) => setReturnSelection(returnId),
    selectMaster: () => setReturnSelection(null),
    selectPlacement,
    location: () => ({
      selection: selection(),
      padSelection: padSelection(),
      openPlacementId: openPlacementId(),
    }),
    restore(location) {
      const current = project();
      setSelection(
        current ? reconcileSelection(location.selection, current) : location.selection,
      );
      setPadSelection(location.padSelection);
      setOpenPlacementId(location.openPlacementId);
    },
  };
}
