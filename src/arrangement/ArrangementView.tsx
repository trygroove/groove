import { For, type JSX, Show } from "@solidjs/web";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import type { Project } from "../domain/entities";
import { createFactoryContext } from "../domain/factories";
import { createIdFactory, type PlacementId, type TrackId } from "../domain/ids";
import { TICKS_PER_BAR } from "../domain/time";
import { createClipAt } from "./clipCreation";
import "../editor/trackDrag.css";
import TrackHeader from "../editor/TrackHeader";
import { deleteTrack } from "../editor/trackDeletion";
import type { TrackLevel } from "../editor/trackLevels";
import { moveTrack, orderedTrackIds, previewTrackOrder } from "../editor/trackReorder";
import type { TrackSelectionSource } from "../editor/trackSurface";
import { useTrackDrag } from "../editor/useTrackDrag";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import {
  type ArrangementBand,
  type ArrangementPosition,
  type ArrangementSelection,
  barStartPoint,
  clipsSelection,
  placementsTouchedBy,
  reconcileArrangementSelection,
} from "../selection";
import { detectPlatform } from "../shortcuts/keys";
import {
  type ModifierEvent,
  pointerModifierHeld,
  suppressModifierDefault,
} from "../shortcuts/pointerGestures";
import { type ArrangementShell, createArrangementShell } from "./arrangementShell";
import { ClipList } from "./ClipList";
import {
  createArrangementWaveformCache,
  type InteractionState,
  RULER_HEIGHT_PX,
} from "./canvasRenderer";
import { clipClickGesture } from "./clipClickGesture";
import { clipListEntries, revealScroll, stepClip } from "./clipListModel";
import { type RowMetrics, ticksToPixels, type Viewport } from "./geometry";
import { LoopBraceFocus } from "./LoopBraceFocus";
import {
  createLoopBraceDrag,
  describeLoopBars,
  hitTestLoopBrace,
  type LoopBraceDrag,
} from "./loopBrace";
import {
  createPlacementEditing,
  type EditingGesture,
  type PlacementEditing,
} from "./placementEditingController";
import {
  type ArrangementProjection,
  buildArrangementProjection,
  type PlacementGeometry,
} from "./projection";
import { describeArrangementSelection } from "./selectionAnnouncement";
import { useArrangementCanvas, visibleViewportSize } from "./useArrangementCanvas";
import { ZoomControls } from "./ZoomControls";
import "./ArrangementView.css";

/** The placement-editing operations `EditorView` wires into the KEY-01
 * registry, mirroring `PianoRollActions`, plus the zoom actions: zoom to
 * selection for `Z` (`view.zoom_to_selection`), to arrangement, in and out. */
export type PlacementEditingActions = PlacementEditing & {
  /** Select the clip one step either way in the clip list (#76). */
  stepClip(by: -1 | 1): void;
  /** Add the clip one step either way in the clip list to the selection (#76). */
  extendClip(by: -1 | 1): void;
  zoomToSelection(): void;
  canZoomToSelection(): boolean;
  zoomToArrangement(): void;
  zoomIn(): void;
  zoomOut(): void;
  scrollToPlayhead(): void;
};

/**
 * The production arrangement editor shell (`ARR-001`; PRD ARR-01, section 9.3).
 *
 * A hybrid DOM + Canvas 2D surface built on the retained FND-008 renderer
 * contracts and the framework-free `ArrangementShell` controller. It provides:
 *
 * - three stacked, dirty-tracked, viewport-sized canvas layers (background grid
 *   + ruler, content clips, interaction playhead/selection/hover), each redrawn
 *   only for its own dirty reason and never on a permanent animation loop;
 * - a native scroll container with a logical-size spacer, so scrollbars,
 *   trackpads, and assistive tech keep browser-native behavior, and canvas
 *   backing stores that resize only on viewport/DPR change (DPR capped at 2);
 * - virtualized DOM track headers windowed to the visible rows, sharing the
 *   shell's row metrics and scroll;
 * - a transport-driven playhead that follows during playback, and the one
 *   arrangement selection (#292): a point, or whole clips a click or a drag
 *   band selected;
 * - a floating zoom group (to arrangement, to selection, in, out) and
 *   an accessible, virtualized track/selection list, so canvas pixels are never
 *   the sole representation of state (PRD 9.3 accessibility).
 *
 * Placement create/move/resize editing (`ARR-002`), section editing
 * (`ARR-003`), and automation editing (`ARR-004`) build their transient
 * gestures on this shell.
 */

/**
 * Uniform per-row sizing. Header height equals the canvas row height so the
 * windowed header column lines up pixel-for-pixel with the timeline.
 *
 * A row is deliberately tall. At 28px a track was a pinstripe: its name barely
 * fit, its clips had no room to show a waveform, and a song read as a dense
 * grey mat rather than as parts you can tell apart at a glance. The arrangement
 * has the whole page now (`UI-001`), so it can spend that height on being
 * legible — which is the point of giving it the page.
 */
export const ROW_METRICS: RowMetrics = {
  trackHeightPx: 84,
  headerHeightPx: 84,
};

/**
 * The vertical scale, published on the arrangement root.
 *
 * The horizontal one already is (`data-pixels-per-tick`): a browser test
 * reaching a track on the canvas has no role or name to aim at, only a
 * coordinate, and a coordinate built from numbers copied into the spec goes
 * stale without going red. Raising the row height from 28 to 84 proved it —
 * every spec carrying its own copy of 28 kept passing, because the old centre
 * of row 0 still landed somewhere inside the new row 0, and the one spec that
 * reached past it for row 1 quietly started clicking row 0.
 *
 * Both halves of a row's centre live here, so a spec derives the whole
 * coordinate from the app instead of half of it.
 */
const VERTICAL_SCALE = {
  "data-row-height": ROW_METRICS.trackHeightPx,
  "data-ruler-height": RULER_HEIGHT_PX,
} as const;

/**
 * The track header column's width. Exported because the instrument view's
 * track rail is the same column in another view — a track occupies the same
 * space wherever the producer meets it, so moving between views does not move
 * the list under their pointer.
 */
export const HEADER_WIDTH_PX = 200;

/**
 * Scrollable space kept below the last track and its add-track unit (`UI-001`).
 *
 * The arrangement runs to the bottom of the window so its grid does not stop
 * at a panel edge, which means the floating dock hovers over its lowest
 * strip. This is what stops that strip ever being a track: there is always
 * this much empty timeline underneath the song and the add-track unit, so
 * both can be scrolled clear of the dock (#959). Matches
 * `--view-dock-clearance` in `EditorView.css`.
 */
const BELOW_TRACKS_CLEARANCE_PX = 120;
/**
 * The horizontal scale the arrangement opens at, in CSS pixels per tick.
 *
 * A song is read in bars, so what this number really sets is how many of them
 * a producer meets on arrival. It used to open on about thirty: enough to see
 * a whole arrangement at once, and too many to see a clip. Roughly sixteen is
 * the working view — two eight-bar sections side by side, with clips wide
 * enough to read.
 */
export const INITIAL_PIXELS_PER_TICK = 0.143;

export interface ArrangementViewProps {
  readonly project: Project;
  /** Live playhead position in ticks (from the transport). */
  readonly playheadTicks?: Accessor<number>;
  /** Whether the transport is playing, so the playhead follows only then. */
  readonly isPlaying?: Accessor<boolean>;
  readonly analytics?: Analytics;
  /**
   * The shared command layer (`ARR-002`). Optional so existing callers/tests
   * that only exercise the ARR-001 shell keep working; placement editing is
   * inert without it.
   */
  readonly dispatch?: (
    commands: RawCommandInput | readonly RawCommandInput[],
  ) => TransactionResult | undefined;
  readonly beginGesture?: (options?: GestureOptions) => Gesture | undefined;
  /** Called once with the placement-editing operations, so `EditorView` can
   * wire them into the KEY-01 registry, mirroring `registerPianoRollActions`. */
  readonly onEditingActionsReady?: (actions: PlacementEditingActions | null) => void;
  /**
   * The track the editor is showing, marked in the header column (#228).
   * Optional, like `onSelectTrack`: without them the arrangement still works,
   * it just marks no row and moves nothing when one is clicked.
   */
  readonly selectedTrackId?: TrackId | null;
  /**
   * The track the user chose on its header (#960): the one Delete removes.
   * Its header is framed, and the live region names it while no clip is
   * selected.
   */
  readonly chosenTrackId?: TrackId | null;
  /** Live post-fader level of a track, for its header's meter (#447). */
  readonly trackLevel?: (trackId: TrackId) => TrackLevel | null;
  /** Called with the track a clicked row belongs to, so the editor can follow
   * it — the arrangement holds no selection state of its own. `how` says
   * whether the user chose it on its header or the list (`"header"`) or the
   * editor only follows a press in its lane or a deletion (`"follow"`). */
  readonly onSelectTrack?: (trackId: TrackId, how: TrackSelectionSource) => void;
  /**
   * Called when a placement is *opened* — double-clicked on the canvas, or
   * opened from the toolbar (`UI-001`). The arrangement reports the gesture;
   * what opening a clip means is the editor's to decide.
   */
  readonly onOpenPlacement?: (placementId: PlacementId) => void;
  /**
   * Called when the selection becomes exactly one clip — a click on it, or
   * anything else that leaves one clip selected (`UI-002`). Selecting a clip
   * is choosing what `2` edits; a double-click also goes there.
   */
  readonly onSelectPlacement?: (placementId: PlacementId) => void;
  /**
   * The selection to start with. The arrangement is only on the page while
   * it is the view (`UI-002`), so a visit to another view rebuilds it; the
   * editor hands back what was selected when it left, through
   * `onSelectionChange`, so the clip you were on is still selected.
   */
  readonly initialSelection?: ArrangementSelection | null;
  /** Called with the arrangement's selection each time it changes. */
  readonly onSelectionChange?: (selection: ArrangementSelection | null) => void;
  /**
   * Rendered in the header column immediately below the last track, scrolling
   * with it — where the way to add a track belongs, because that is where the
   * song ends and the next track would go. The arrangement positions it and
   * knows nothing else about it; what adding a track means stays the editor's.
   */
  readonly belowTracks?: JSX.Element;
  /**
   * Reports whether the ruler's loop brace has keyboard focus (`LOOP-018`).
   * The brace's keys are registry mappings, so the editor needs to know when to
   * turn their context on. Without it the brace has no keyboard twin.
   */
  readonly onLoopBraceFocusChange?: (focused: boolean) => void;
  /**
   * Reports whether the clip list has keyboard focus (#76), so the editor can
   * turn on the `clip_list` context its arrows live in. Without it the list is
   * still read out, but the arrows do not step through it.
   */
  readonly onClipListFocusChange?: (focused: boolean) => void;
  /**
   * Parts of the song another surface points at (GRV-42: an option of the
   * assistant's question, hovered), drawn over the clips as bands. Nothing
   * is selected by it.
   */
  readonly highlight?: Accessor<readonly ArrangementBand[]>;
}

export default function ArrangementView(props: ArrangementViewProps) {
  const analytics = () => props.analytics ?? defaultAnalytics;

  /** Drag a header up or down the column to reorder its track (TRK-02). */
  const trackDrag = useTrackDrag({
    axis: "y",
    zone: () => headerColumnEl,
    indexOf: (trackId) => orderedTrackIds(props.project).indexOf(trackId),
    onDrop: (trackId, toIndex) => {
      const dispatch = props.dispatch;
      if (!dispatch) return;
      moveTrack(
        { project: () => props.project, dispatch, analytics: analytics() },
        trackId,
        toIndex,
        { view: "arrangement", method: "drag" },
      );
    },
  });

  /** The header's trash button (#537): delete, then show the neighbour. */
  const deleteSelectedTrack = (trackId: TrackId) => {
    const dispatch = props.dispatch;
    if (!dispatch) return;
    deleteTrack(
      {
        project: () => props.project,
        dispatch,
        select: (id) => props.onSelectTrack?.(id, "follow"),
        analytics: analytics(),
      },
      trackId,
    );
  };

  /** Whether `trackId` is the one drawn at a drag's would-be landing row. */
  const previewing = (trackId: TrackId) =>
    trackDrag.dragging() === trackId && trackDrag.target() !== null;

  /** The project as drawn: mid-drag, the dragged track already sits in the
   * row it would land in, header and lane, before the drop commits it. */
  const projection = createMemo<ArrangementProjection>(() => {
    const [dragged, to] = [trackDrag.dragging(), trackDrag.target()];
    const moved = dragged !== null && to !== null;
    const shown = moved ? previewTrackOrder(props.project, dragged, to) : props.project;
    return buildArrangementProjection(shown, ROW_METRICS);
  });

  // A tiny signal bumped whenever the shell mutates viewport/selection state,
  // so the reactive header column and accessible list re-read the shell.
  const [stateVersion, setStateVersion] = createSignal(0);

  let scrollEl!: HTMLDivElement;
  let spacerEl: HTMLDivElement | undefined;
  let belowTracksEl: HTMLDivElement | undefined;
  let headerListEl!: HTMLUListElement;
  let headerColumnEl: HTMLDivElement | undefined;
  let backgroundCanvas!: HTMLCanvasElement;
  let contentCanvas!: HTMLCanvasElement;
  let interactionCanvas!: HTMLCanvasElement;

  const waveformCache = createArrangementWaveformCache();
  let shell: ArrangementShell | null = null;
  let firstUseLogged = false;
  let editing: PlacementEditing | null = null;
  // Minted once for this component instance, like `waveformCache` above — an
  // `IdFactory` is a plain closure, not reactive state, and must persist
  // across renders rather than being rebuilt inside one.
  const ids = createIdFactory();
  // Unique per instance, so two arrangements never share a described-by target.
  const loopMirrorId = createUniqueId();
  // The placement drag in flight, if any: which pointer owns it, so a stray
  // move/up from another pointer is ignored.
  let activePointerId: number | null = null;
  // Whether that drag holds a clip's edge, which resizes or tiles rather than
  // moving, so it keeps the resize cursor for its whole length.
  let edgeDrag = false;
  // The loop brace on the ruler (LOOP-018): one drag at a time, one gesture
  // each. It only exists when the host supplies gestures.
  let loopDrag: LoopBraceDrag | null = null;
  // A press in empty space, while its pointer is down: where it was pressed,
  // so a jitter of a pixel or two stays a click rather than a sliver of band.
  let bandPress: { pointerId: number; x: number; y: number; moved: boolean } | null =
    null;
  // While a clip-body drag runs, the browser is kept off the copy modifier's
  // own key (ARR-011); this ends that, passing whether it is still held. It is
  // kept after the drop, since a modifier still held then is guarded until its
  // release, and called bare to let go for good (next press, or unmount).
  let releaseCopyModifier: ((held?: boolean) => void) | null = null;
  const platform = detectPlatform();
  /** Whether the Alt-drag copy modifier is held, as the registry defines it. */
  const copyHeld = (event: ModifierEvent): boolean =>
    pointerModifierHeld("arrangement.drag_copy", event, platform);

  function initialViewport(): Viewport {
    return {
      scrollLeft: 0,
      scrollTop: 0,
      width: 960,
      height: 480,
      pixelsPerTick: INITIAL_PIXELS_PER_TICK,
    };
  }

  function interactionState(): InteractionState {
    const state = shell?.getState();
    const selection = editing?.getArrangementSelection() ?? null;
    const band = editing?.getBand() ?? null;
    return {
      playheadTicks: state?.playheadTicks ?? null,
      band,
      point: selection?.kind === "point" ? selection : null,
      hoverPlacementId: state?.hoverPlacementId ?? null,
      // While a band sweeps, the clips it touches are drawn as the selection
      // they will become on release.
      selectedPlacementIds: new Set(
        (band ? editing?.bandPlacementIds() : editing?.getSelection()) ?? [],
      ),
      highlight: untrack(() => props.highlight?.()) ?? [],
    };
  }

  // A highlight from outside redraws the interaction layer alone. The bands
  // are the one reactive read; marking the layer is the apply half's.
  createEffect(
    () => props.highlight?.(),
    () => shell?.markDirty("interaction"),
  );

  // --- Placement editing (ARR-002) adapters ---------------------------------
  //
  // `createPlacementEditing` wants a `dispatch` with no return value and a
  // `beginGesture` returning its own `EditingGesture` shape, which differs
  // from `UseEditorSessionResult`'s `Gesture`/`dispatch` (see
  // `useEditorSession.ts`). These adapters translate without adding a second
  // mutation path: every command still flows through `props.dispatch`/
  // `props.beginGesture`, i.e. the shared command layer.

  function adaptGesture(gesture: Gesture): EditingGesture {
    return {
      apply: (commands) => {
        gesture.apply(commands);
      },
      commit: (summary) => {
        gesture.commit(summary);
      },
      cancel: () => gesture.cancel(),
    };
  }

  // The canvas lifecycle — frame scheduling, DPR sizing, per-layer dirty
  // dispatch, resize observation — lives in `useArrangementCanvas`. The shell
  // and the canvas refs are read through accessors because both are assigned
  // during render/mount, after this call.
  const canvas = useArrangementCanvas({
    shell: () => shell,
    projection: () => projection(),
    canvases: () => ({
      background: backgroundCanvas,
      content: contentCanvas,
      interaction: interactionCanvas,
    }),
    interactionState,
    waveformCache,
    loop: () => props.project.song.loop,
    translucentTrackId: () => trackDrag.dragging(),
  });

  // Picking a track up or putting it down changes how its lane is drawn even
  // when the rows have not moved yet, so redraw the canvas on either edge.
  //
  // `invalidateAll` re-clamps scroll against the projection memo; that read is
  // deliberate and covered by the projection effect below, so it runs under
  // `untrack` rather than logging `STRICT_READ_UNTRACKED` (#844).
  createEffect(
    () => trackDrag.dragging(),
    () => untrack(() => shell?.invalidateAll()),
  );

  /** One arrangement interaction the user initiated: the once-per-account
   * `feature_first_use` for `arrangement` (PRD OPS-02). */
  function noteFirstUse(): void {
    if (firstUseLogged) return;
    firstUseLogged = analytics().logFeatureFirstUse("arrangement");
  }

  /** The clip the clip list's arrows last moved to (#76). Plain, not a
   * signal: it only ever changes with the selection, whose own bump is what
   * redraws the list. */
  let activeClipId: PlacementId | null = null;

  function bumpState(): void {
    setStateVersion((value) => value + 1);
  }

  // The one clip last reported selected, so a drag over it, which changes
  // state on every step, does not report it again each time.
  let reportedPlacementId: PlacementId | null = null;
  /** Tell the host when exactly one clip has become the selection (`UI-002`). */
  function onlyPlacement(selected: ArrangementSelection | null | undefined) {
    return selected?.kind === "clips" && selected.placementIds.length === 1
      ? selected.placementIds[0]
      : null;
  }
  function reportSelectedPlacement(): void {
    const selected = editing?.getArrangementSelection() ?? null;
    props.onSelectionChange?.(selected);
    const only = onlyPlacement(selected);
    if (only === reportedPlacementId) return;
    reportedPlacementId = only;
    if (only) props.onSelectPlacement?.(only);
  }

  /**
   * Point the editor at a track (#228). Clicking a row is how you say "this
   * one" here, exactly as clicking a strip is in the mixer; the arrangement
   * reports it and the host decides, so this surface keeps no selected-track
   * state of its own.
   */
  function selectTrack(trackId: TrackId, how: TrackSelectionSource): void {
    props.onSelectTrack?.(trackId, how);
    noteFirstUse();
  }

  /** The track under a viewport-local point, or null above/below the rows. */
  function trackAt(localX: number, localY: number): TrackId | null {
    if (!shell) return null;
    const { rowIndex } = shell.pointToArrangement(localX, localY);
    return projection().tracks[rowIndex]?.id ?? null;
  }

  // `onSettled` is Solid 2's lifecycle hook, and it runs before the effects
  // below get their first apply — the same order 1.x's `onMount` gave us — so
  // both still see a live shell on their first run. The refs are assigned and
  // the elements are in the document by then, which is what `observeViewport`
  // and the priming measurement need.
  onSettled(() => {
    shell = createArrangementShell(() => projection(), {
      initialViewport: initialViewport(),
      config: { maxDevicePixelRatio: 2, extraHeightPx: extraHeightPx() },
      onDirty: () => canvas.scheduleDraw(),
    });

    // Always created, because it holds the arrangement's one selection. Its
    // edits are inert without `props.dispatch`, which is optional.
    editing = createPlacementEditing({
      getProject: () => props.project,
      dispatch: (commands) => {
        props.dispatch?.(commands);
      },
      beginGesture: (summary) => {
        const gesture = props.beginGesture?.({ summary });
        return gesture && adaptGesture(gesture);
      },
      ids,
      analytics: analytics(),
      onChange: () => {
        shell?.markDirty("interaction");
        bumpState();
        reportSelectedPlacement();
      },
    });
    // Back from another view: the selection it left with, less anything the
    // project lost meanwhile. Restoring it is not a new choice of clip, so it
    // is not reported as one.
    const restored =
      props.initialSelection &&
      reconcileArrangementSelection(props.initialSelection, props.project);
    if (restored) {
      reportedPlacementId = onlyPlacement(restored);
      editing.setSelection(restored);
    }
    if (props.dispatch) {
      props.onEditingActionsReady?.({
        ...editing,
        stepClip: (by) => stepClipFromList(by, false),
        extendClip: (by) => stepClipFromList(by, true),
        zoomToSelection,
        canZoomToSelection: () => canZoomToSelection(),
        zoomToArrangement,
        zoomIn,
        zoomOut,
        scrollToPlayhead,
      });
    }

    if (props.beginGesture) {
      const beginGesture = props.beginGesture;
      loopDrag = createLoopBraceDrag({
        getLoop: () => props.project.song.loop,
        beginGesture: (summary) => {
          const gesture = beginGesture({ summary });
          return (
            gesture && {
              apply: (commands) => {
                gesture.apply(commands);
              },
              commit: (commitSummary) => {
                gesture.commit(commitSummary);
              },
              cancel: () => gesture.cancel(),
            }
          );
        },
        analytics: analytics(),
      });
    }

    // Installed before the measurement below on purpose: a `ResizeObserver`
    // delivers the element's current size as soon as it starts observing, so
    // a viewport that is not laid out yet at this instant still reaches the
    // shell on that first delivery rather than waiting for a user resize.
    canvas.observeViewport(scrollEl, bumpState);
    const belowTracksObserver = observeBelowTracks();

    // Prime the initial size and paint every layer once.
    const size = visibleViewportSize(scrollEl);
    if (size.width > 0 && size.height > 0) {
      shell.resize(size.width, size.height);
    } else {
      shell.markDirty("background", "content", "interaction");
    }
    bumpState();

    // The labels are drawn text, so a first paint before Inter has loaded
    // uses the fallback face. Repaint once the document's fonts are in.
    void document.fonts?.ready.then(() =>
      shell?.markDirty("background", "content", "interaction"),
    );

    // The teardown for the registration above. In Solid 2 the value an
    // `onSettled` callback returns *is* its cleanup, which is what pairs it
    // with the setup here instead of a detached `onCleanup`.
    return () => {
      props.onEditingActionsReady?.(null);
      releaseCopyModifier?.();
      belowTracksObserver?.disconnect();
    };
  });

  /**
   * The scrollable height past the rows: the ruler above them, the add-track
   * unit under them, and the dock's clearance under that. The unit is
   * measured, not assumed, because a narrow window wraps it onto more lines.
   */
  function extraHeightPx(): number {
    return (
      RULER_HEIGHT_PX + (belowTracksEl?.offsetHeight ?? 0) + BELOW_TRACKS_CLEARANCE_PX
    );
  }

  /** Keeps the scroll range in step with the add-track unit's height. */
  function observeBelowTracks(): ResizeObserver | undefined {
    if (!belowTracksEl || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => {
      shell?.setExtraHeight(extraHeightPx());
      syncSpacer();
      bumpState();
    });
    observer.observe(belowTracksEl);
    return observer;
  }

  // Project identity / structure changed: everything is dirty, scroll bounds
  // re-clamp. The projection memo makes this reactive to any project change,
  // but an unrelated edit still only re-runs the cheap projection build, and a
  // no-op reconcile (same object) means the shell re-clamps to unchanged
  // bounds and redraws once. An undo/redo or remote edit can also remove a
  // selected placement out from under the controller, so it drops any
  // selected ID the project no longer contains (see `reconcile`'s doc comment).
  //
  // `projection()` is this effect's only reactive dependency, and the split is
  // load-bearing rather than stylistic: `syncSpacer` and `bumpState` both
  // write signals, which Solid 2 forbids in a tracking scope and sanctions in
  // the apply half.
  //
  // The apply half re-reads the same memo indirectly — `invalidateAll` clamps
  // scroll against the shell's own `getProjection` closure, `syncSpacer` reads
  // it for the logical size, `reconcile` reads `props.project` behind it — and
  // in dev each of those would log `STRICT_READ_UNTRACKED` (#844). Here that
  // diagnostic is a false positive rather than a missed dependency: the compute
  // half above subscribes to exactly the memo those reads resolve, so the
  // effect does re-run and they do see the new value. So the apply half runs
  // under a deliberate `untrack`, which is Solid's way of saying "read once,
  // knowingly" and keeps the diagnostic for reads that really are missed.
  createEffect(
    () => projection(),
    () =>
      untrack(() => {
        shell?.invalidateAll();
        editing?.reconcile();
        syncSpacer();
        bumpState();
      }),
  );

  // Transport playhead follow: seek the shell to the live position while
  // playing. `seekTo` only marks the interaction layer dirty and follows the
  // playhead into view; a stopped transport advances nothing, so the surface
  // stays idle (PRD 9.3 "must not run a permanent 60 Hz loop while stopped").
  //
  // Both the props and the accessors they hold are read in the compute half —
  // `props.playheadTicks` can be swapped for a different accessor and the
  // accessor's own value changes every transport tick, so all four reads have
  // to stay here for the playhead to keep following.
  createEffect(
    () => ({
      ticks: props.playheadTicks?.() ?? 0,
      playing: props.isPlaying?.() ?? false,
    }),
    ({ ticks, playing }) => {
      if (!shell) return;
      shell.setPlayheadFollow(playing);
      const scrollLeftBefore = shell.getViewport().scrollLeft;
      shell.seekTo(ticks);
      // Follow turned the page: move the native scroll container with it, so
      // the scrollbar, the DOM overlays, and the next wheel scroll all start
      // from the page on screen. Only on a page turn, not every frame (#964).
      if (shell.getViewport().scrollLeft !== scrollLeftBefore) {
        syncSpacer();
        syncScrollElToShell();
        bumpState();
      }
    },
  );

  function syncSpacer(): void {
    if (!shell) return;
    const port = shell.getViewport();
    const logicalWidth = shell.contentLengthTicks() * port.pixelsPerTick;
    // The shell's own height, so the native scroller and the shell's scroll
    // clamp agree on where the bottom is (#959).
    const logicalHeight = shell.contentHeight();
    // Written straight onto the element rather than through a signal: a zoom
    // sets the native `scrollLeft` right after this, and the browser clamps it
    // to the spacer's size at that instant. A reactive write would land after
    // the clamp, so zooming onto a span past the old width would snap back.
    if (spacerEl) {
      spacerEl.style.width = `${Math.max(logicalWidth, port.width)}px`;
      spacerEl.style.height = `${Math.max(logicalHeight, port.height)}px`;
    }
  }

  // --- Native scroll → shell (scrollbar synchronization) --------------------
  function handleScroll(): void {
    if (!shell) return;
    shell.setScroll(scrollEl.scrollLeft, scrollEl.scrollTop);
    bumpState();
  }

  // --- Wheel: plain scroll is native; ctrl/cmd-wheel zooms anchored ---------
  function handleWheel(event: WheelEvent): void {
    if (!shell) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = scrollEl.getBoundingClientRect();
      shell.handleWheel({
        deltaX: 0,
        deltaY: event.deltaY,
        zoom: true,
        anchorX: event.clientX - rect.left,
      });
      syncSpacer();
      syncScrollElToShell();
      bumpState();
      noteFirstUse();
    }
    // Non-zoom wheel falls through to the browser's native scroll, which
    // fires `scroll` and drives the shell through `handleScroll`.
  }

  /** After a zoom (which the shell computes), push the shell's scrollLeft back
   * onto the native scroll element so its scrollbar stays synchronized. */
  function syncScrollElToShell(): void {
    if (!shell || !scrollEl) return;
    const port = shell.getViewport();
    if (scrollEl.scrollLeft !== port.scrollLeft) {
      scrollEl.scrollLeft = port.scrollLeft;
    }
    if (scrollEl.scrollTop !== port.scrollTop) {
      scrollEl.scrollTop = port.scrollTop;
    }
  }

  // --- Pointer over the interaction canvas ----------------------------------
  /** How far the pointer must travel before a press becomes a drag band. */
  const BAND_DRAG_THRESHOLD_PX = 3;

  function localPoint(event: MouseEvent): { x: number; y: number } {
    const rect = interactionCanvas.getBoundingClientRect();
    // The ruler occupies the top strip and does not host rows.
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - RULER_HEIGHT_PX,
    };
  }

  /** The track and tick under a viewport-local point, with the row clamped to
   * the song's tracks so a band dragged past the last one still ends on it. */
  function positionAt(localX: number, localY: number): ArrangementPosition | null {
    if (!shell) return null;
    const { rowIndex, tick } = shell.pointToArrangement(localX, localY);
    const tracks = projection().tracks;
    const track = tracks[Math.max(0, Math.min(tracks.length - 1, rowIndex))];
    return track ? { trackId: track.id, ticks: tick } : null;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!shell) return;
    if (loopDrag?.isDragging() && event.pointerId === activePointerId) {
      loopDrag.update(shell.pointToArrangement(localPoint(event).x, 0).tick);
      return;
    }
    if (bandPress && event.pointerId === bandPress.pointerId) {
      const { x, y } = localPoint(event);
      if (Math.hypot(x - bandPress.x, y - bandPress.y) >= BAND_DRAG_THRESHOLD_PX) {
        bandPress.moved = true;
      }
      const position = positionAt(x, y);
      if (bandPress.moved && position) editing?.updateBand(position);
      return;
    }
    if (editing?.isDragging() && event.pointerId === activePointerId) {
      const { x, y } = localPoint(event);
      const { tick } = shell.pointToArrangement(x, y);
      const copy = copyHeld(event);
      editing.updateDrag(tick, copy);
      // The cursor says which a drop here would do: resize (an edge, where Alt
      // changes nothing), copy, or move.
      interactionCanvas.style.cursor = edgeDrag ? "ew-resize" : copy ? "copy" : "";
      return;
    }
    const { x, y } = localPoint(event);
    if (y < 0) {
      shell.clearHover();
      interactionCanvas.style.cursor = loopCursor(loopHandleAt(x));
      return;
    }
    shell.handlePointerMove(x, y);
    interactionCanvas.style.cursor = placementCursor(shell.hitTestAt(x, y));
  }

  /** A clip's edge is its resize handle, so hovering it shows a resize cursor. */
  function placementCursor(hit: ReturnType<ArrangementShell["hitTestAt"]>): string {
    return hit.kind === "placement" && hit.handle !== "body" ? "ew-resize" : "";
  }

  /**
   * Open the placement under the pointer (`UI-001`). Double-click is the
   * gesture every DAW uses for "open this clip", and the one CF-001 and CF-008
   * walk.
   */
  function handleDoubleClick(event: MouseEvent): void {
    if (!shell) return;
    const { x, y } = localPoint(event);
    if (y < 0) return;
    const hit = shell.hitTestAt(x, y);
    if (hit.kind === "placement") {
      props.onOpenPlacement?.(hit.placementId);
      noteFirstUse();
      return;
    }
    createClipAtPoint(x, y);
  }

  /** An empty bar double-clicked gets a new, selected one-bar clip (#661). */
  function createClipAtPoint(x: number, y: number): void {
    if (!shell || !props.dispatch) return;
    const { tick, rowIndex } = shell.pointToArrangement(x, y);
    const track = projection().tracks[rowIndex];
    if (!track) return;
    const created = createClipAt(
      props.project,
      createFactoryContext({ ids }),
      track.id,
      tick,
    );
    if (!created) return;
    const result = props.dispatch(created.commands);
    if (result && !result.ok) return;
    editing?.select(created.placementId);
    analytics().logFeatureFirstUse("arrangement_create_clip");
  }

  /** The part of the loop brace under a ruler x, if any. */
  function loopHandleAt(x: number) {
    if (!shell) return null;
    return hitTestLoopBrace(props.project.song.loop, x, shell.getViewport());
  }

  function loopCursor(handle: ReturnType<typeof loopHandleAt>): string {
    if (handle === "start" || handle === "end") return "ew-resize";
    return handle === "body" ? "grab" : "";
  }

  /** A press on the ruler grabs the loop brace, or does nothing at all. */
  function handleRulerPointerDown(event: PointerEvent, x: number): void {
    if (!shell || !loopDrag || (event.button ?? 0) !== 0) return;
    const handle = loopHandleAt(x);
    if (!handle) return;
    if (!loopDrag.begin(handle, shell.pointToArrangement(x, 0).tick)) return;
    activePointerId = event.pointerId;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    noteFirstUse();
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!shell) return;
    const { x, y } = localPoint(event);
    if (y < 0) {
      handleRulerPointerDown(event, x);
      return;
    }

    // Whatever the click turns out to do — start a placement drag, sweep a
    // band, set a point — it happened on a row, and that row's track is now the one
    // being worked on (#228). Shown, not chosen: a press in a lane is never
    // what makes Delete take the whole track (#960).
    const trackId = trackAt(x, y);
    if (trackId) selectTrack(trackId, "follow");

    if ((event.button ?? 0) !== 0 || !editing) return;
    const target = event.currentTarget as Element;

    // A press on a clip selects it and starts a drag that moves or resizes it.
    // With Cmd/Ctrl or Shift held it only changes the selection (#405).
    const hit = shell.hitTestAt(x, y);
    const gesture = clipClickGesture(event);
    if (hit.kind === "placement" && gesture !== "replace") {
      if (gesture === "toggle") editing.toggleClip(hit.placementId);
      else editing.extendTo(hit.placementId);
      bumpState();
      noteFirstUse();
      return;
    }
    if (hit.kind === "placement") {
      const { tick } = shell.pointToArrangement(x, y);
      editing.beginDrag(hit.placementId, hit.handle, tick);
      edgeDrag = hit.handle !== "body";
      if (hit.handle === "body") {
        releaseCopyModifier?.();
        releaseCopyModifier = suppressModifierDefault("arrangement.drag_copy", window);
      }
      activePointerId = event.pointerId;
      target.setPointerCapture?.(event.pointerId);
      bumpState();
      noteFirstUse();
      return;
    }

    // A press in empty space is a click or the start of a drag band (#292),
    // which the pointer's release decides.
    if (!trackId) {
      editing.clearSelection();
      return;
    }
    editing.beginBand({ trackId, ticks: shell.pointToArrangement(x, y).tick });
    bandPress = { pointerId: event.pointerId, x, y, moved: false };
    target.setPointerCapture?.(event.pointerId);
    noteFirstUse();
  }

  /** Release a press in empty space: a band selects the clips it touched, and
   * a click sets the point at the start of the bar it landed in. */
  function endBandPress(): void {
    if (!bandPress || !editing) return;
    const { x, y } = bandPress;
    bandPress = null;
    if (editing.endBand()) return;
    const position = positionAt(x, y);
    if (position) editing.placePoint(position);
  }

  function endActiveDrag(event: PointerEvent): void {
    if (loopDrag?.isDragging() && event.pointerId === activePointerId) {
      loopDrag.end();
      activePointerId = null;
      (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
      return;
    }
    if (bandPress && event.pointerId === bandPress.pointerId) {
      if (event.type === "pointercancel") {
        bandPress = null;
        editing?.cancelBand();
      } else {
        endBandPress();
      }
      (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
      return;
    }
    if (event.pointerId !== activePointerId) return;
    // Alt is read at the drop (ARR-011). A drag Escape already cancelled has
    // nothing left to end, but its pointer and modifier are still let go.
    const copy = event.type !== "pointercancel" && copyHeld(event);
    releaseCopyModifier?.(copy);
    interactionCanvas.style.cursor = "";
    edgeDrag = false;
    if (editing?.isDragging()) editing.endDrag(copy);
    activePointerId = null;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    bumpState();
  }

  // --- Named DOM actions (also the keyboard/accessibility equivalents) ------
  function zoomIn(): void {
    shell?.zoomIn();
    syncSpacer();
    syncScrollElToShell();
    bumpState();
    noteFirstUse();
  }
  function zoomOut(): void {
    shell?.zoomOut();
    syncSpacer();
    syncScrollElToShell();
    bumpState();
    noteFirstUse();
  }
  /** Frame the selected clips' extent, or the one clicked clip (#292). */
  function zoomToSelection(): void {
    const span = editing?.selectionSpan();
    if (!span) return;
    shell?.zoomToSpan(span.startTicks, span.endTicks);
    syncSpacer();
    syncScrollElToShell();
    bumpState();
    noteFirstUse();
  }
  /** Frame the whole song, from its first bar to the end of its last clip. */
  function zoomToArrangement(): void {
    shell?.zoomToSpan(0, Math.max(projection().lengthTicks, TICKS_PER_BAR));
    syncSpacer();
    syncScrollElToShell();
    bumpState();
    noteFirstUse();
  }
  function scrollToPlayhead(): void {
    shell?.scrollToPlayhead();
    syncScrollElToShell();
    bumpState();
    noteFirstUse();
  }

  /**
   * The clip list's arrows (#76): select the next or previous clip in reading
   * order, exactly as a click on it would, and scroll it into view so the
   * canvas shows a sighted keyboard user where they are. With `extend` (Shift)
   * the clip joins the selection instead, as a modified click adds one, and
   * the next step carries on from it.
   */
  function stepClipFromList(by: -1 | 1, extend: boolean): void {
    if (!editing) return;
    const next = stepClip(
      clipEntries().map((entry) => entry.id),
      clipListActive(),
      by,
    );
    if (!next) return;
    activeClipId = next;
    if (!extend) editing.select(next);
    else if (!editing.getSelection().includes(next)) editing.select(next, true);
    else bumpState();
    const placement = projection().placementsById.get(next);
    if (placement) {
      selectTrack(placement.trackId, "follow");
      revealPlacement(placement);
    }
    analytics().logFeatureFirstUse("arrangement_clip_list");
  }

  /** Scroll the timeline as little as it takes to show a clip. */
  function revealPlacement(placement: PlacementGeometry): void {
    if (!shell) return;
    const viewport = shell.getViewport();
    const rowTop = projection().rowOffsets[placement.rowIndex] ?? 0;
    const next = revealScroll(
      {
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        width: viewport.width,
        // The ruler covers the top of the view; the rows scroll under it.
        height: Math.max(0, viewport.height - RULER_HEIGHT_PX),
      },
      {
        left: placement.startTicks * viewport.pixelsPerTick,
        right: placement.endTicks * viewport.pixelsPerTick,
        top: rowTop,
        bottom: rowTop + ROW_METRICS.trackHeightPx,
      },
    );
    if (
      next.scrollLeft === viewport.scrollLeft &&
      next.scrollTop === viewport.scrollTop
    ) {
      return;
    }
    shell.setScroll(next.scrollLeft, next.scrollTop);
    syncScrollElToShell();
    bumpState();
  }

  /**
   * Select a track's first bar from the accessible list, for a keyboard-only
   * user who never touches the canvas (PRD 9.3: "Keyboard navigation updates
   * selection through the same model as pointer hit testing"). It selects the
   * clips a band over that bar would touch, and with none there it sets the
   * point at the bar's start, so a paste still has somewhere to land.
   */
  function selectTrackFromList(rowIndex: number): void {
    const track = projection().tracks[rowIndex];
    if (!track || !editing) return;
    const band = { trackIds: [track.id], startTicks: 0, endTicks: TICKS_PER_BAR };
    editing.setSelection(
      clipsSelection(placementsTouchedBy(band, props.project)) ??
        barStartPoint({ trackId: track.id, ticks: 0 }),
    );
    // The same click a pointer makes on the row: it selects *and* points the
    // editor at the track (#228).
    selectTrack(track.id, "header");
    bumpState();
  }

  /** The domain tracks by id, once per project, for the header rows. */
  const tracksById = createMemo(
    () => new Map(props.project.song.tracks.map((track) => [track.id, track])),
  );
  /** The domain track a header row shows: its mixer, its colour. */
  const trackOf = (trackId: TrackId) => tracksById().get(trackId);

  // The visible window of track rows, recomputed from the shell's row range.
  const headerRows = createMemo(() => {
    stateVersion();
    if (!shell) return [] as ArrangementProjection["tracks"][number][];
    const range = shell.rowRange();
    const tracks = projection().tracks;
    const rows: ArrangementProjection["tracks"][number][] = [];
    for (let index = range.startRow; index <= range.endRow; index += 1) {
      const track = tracks[index];
      if (track) rows.push(track);
    }
    return rows;
  });

  /**
   * The timeline's horizontal scale, published so a test can turn a musical
   * position into the pixel a gesture has to land on. Clips are canvas pixels
   * with no DOM node to aim at, so without this every browser test would
   * hard-code the zoom the shell happened to start at.
   */
  const pixelsPerTick = createMemo(() => {
    stateVersion();
    return shell?.getViewport().pixelsPerTick ?? INITIAL_PIXELS_PER_TICK;
  });

  const scrollTopMemo = createMemo(() => {
    stateVersion();
    return shell?.getViewport().scrollTop ?? 0;
  });

  /** Where the loop brace sits on the timeline, in pixels local to it. */
  const braceBox = createMemo(() => {
    stateVersion();
    const viewport = shell?.getViewport() ?? initialViewport();
    const { startTicks, endTicks } = props.project.song.loop;
    const left = ticksToPixels(startTicks, viewport) - viewport.scrollLeft;
    return { leftPx: left, widthPx: ticksToPixels(endTicks - startTicks, viewport) };
  });

  // A brace that goes away with focus in it must not leave its key context on.
  onCleanup(() => props.onLoopBraceFocusChange?.(false));

  /** What the `aria-live` mirror says about the one selection (#292). */
  const announcement = createMemo(() => {
    stateVersion();
    return describeArrangementSelection(
      editing?.getArrangementSelection() ?? null,
      props.project,
      props.chosenTrackId ?? null,
    );
  });

  /** Whether zoom to selection has anything to frame: selected clips. */
  const canZoomToSelection = createMemo(() => {
    stateVersion();
    return props.project !== undefined && (editing?.selectionSpan() ?? null) !== null;
  });

  /** The placement-editing selection (CLP-01), for the duplicate-mode toolbar
   * and the accessible mirror below — canvas pixels are never the sole
   * representation of which placements are selected. */
  const placementSelection = createMemo(() => {
    stateVersion();
    return editing?.getSelection() ?? [];
  });

  /** Every clip, in the clip list's reading order (#76). */
  const clipEntries = createMemo(() => clipListEntries(projection()));
  /** The clip the list's arrows stand on: the last one they moved to while it
   * is still selected, else the first selected clip. Read from the controller,
   * not a memo, so two steps in one tick each start where the last one ended. */
  const clipListActive = (): PlacementId | null => {
    const selected = editing?.getSelection() ?? [];
    return activeClipId !== null && selected.includes(activeClipId)
      ? activeClipId
      : (selected[0] ?? null);
  };
  const shownClipListActive = createMemo(() => {
    stateVersion();
    return clipListActive();
  });

  return (
    <div
      class="arrangement-view"
      data-testid="arrangement-view-ready"
      // Where the editor puts focus it lost (#76): inside the arrangement, so
      // its keys (select all, Enter, Escape) keep working from there.
      data-focus-home
      tabindex={-1}
      data-pixels-per-tick={pixelsPerTick()}
      {...VERTICAL_SCALE}
    >
      <div class="arrangement-body">
        <div
          class="arrangement-headers"
          ref={headerColumnEl}
          style={{ width: `${HEADER_WIDTH_PX}px` }}
        >
          <div class="arrangement-headers-ruler-spacer" />
          <ul
            class="arrangement-headers-inner"
            ref={headerListEl}
            aria-label="Tracks"
            style={{ transform: `translateY(${-scrollTopMemo()}px)` }}
          >
            {/* Keyed on the id: the projection mints new rows on every edit, and a
                row rebuilt mid-drag loses its header's fader under the pointer. */}
            <For each={headerRows()} keyed={(track) => track.id}>
              {(track) => (
                <li
                  class={[
                    "arrangement-header-row",
                    { "track-dragging": trackDrag.dragging() === track().id },
                  ]}
                  data-track-drag={track().id}
                  data-testid={
                    previewing(track().id) ? "track-drop-indicator" : undefined
                  }
                  style={{
                    position: "absolute",
                    top: `${track().rowIndex * ROW_METRICS.headerHeightPx}px`,
                    height: `${ROW_METRICS.headerHeightPx}px`,
                    width: "100%",
                  }}
                >
                  <Show when={trackOf(track().id)}>
                    {(domainTrack) => (
                      <TrackHeader
                        track={domainTrack()}
                        selected={props.selectedTrackId === track().id}
                        chosen={
                          props.chosenTrackId === undefined
                            ? undefined
                            : props.chosenTrackId === track().id
                        }
                        onSelect={() => selectTrack(track().id, "header")}
                        dispatch={props.dispatch}
                        beginGesture={props.beginGesture}
                        trackLevel={(trackId) => props.trackLevel?.(trackId) ?? null}
                        onDragStart={(event) => {
                          if (props.dispatch) trackDrag.begin(event, track().id);
                        }}
                        onDelete={() => deleteSelectedTrack(track().id)}
                        surface="arrangement"
                        analytics={analytics()}
                      />
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
        <div
          class="arrangement-viewport"
          ref={scrollEl}
          onScroll={handleScroll}
          onWheel={handleWheel}
        >
          {/* Logical-size spacer: gives the native scroll container real,
					    browser-native scrollbars over the whole arrangement, while
					    the canvases below stay viewport-sized and sticky. */}
          <div class="arrangement-spacer" ref={spacerEl} />
          {/* Not blocked, and — since ADR 0003 — deliberately recorded. Canvas
					    capture is on, so clip blocks, notes, waveforms, and the section
					    names drawn here all reach the payload. That is the decision, not
					    an oversight: dragging a clip edge and placing a note are the
					    interactions replay exists to show, and blocking this stack is
					    what made the arrangement a grey box. Masking does not reach
					    inside a canvas, so nothing here is half-protected — the
					    disclosure says so instead. */}
          <div class="arrangement-canvas-stack">
            <canvas class="arrangement-layer" ref={backgroundCanvas} />
            <canvas class="arrangement-layer" ref={contentCanvas} />
            <canvas
              class="arrangement-layer arrangement-layer-interactive"
              ref={interactionCanvas}
              onPointerMove={handlePointerMove}
              onPointerDown={handlePointerDown}
              onPointerUp={endActiveDrag}
              onPointerCancel={endActiveDrag}
              onDblClick={handleDoubleClick}
              onPointerLeave={(event) => {
                if (event.pointerId === activePointerId) return;
                shell?.clearHover();
              }}
            />
          </div>
        </div>
        <ZoomControls
          onZoomToArrangement={zoomToArrangement}
          onZoomToSelection={zoomToSelection}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          hasSelection={canZoomToSelection()}
        />
        <Show when={props.onLoopBraceFocusChange}>
          {(onFocusChange) => (
            <LoopBraceFocus
              loop={props.project.song.loop}
              leftPx={braceBox().leftPx}
              widthPx={braceBox().widthPx}
              insetPx={HEADER_WIDTH_PX}
              describedBy={loopMirrorId}
              onFocusChange={onFocusChange()}
            />
          )}
        </Show>
        {/* Outside the "Tracks" list on purpose: it is not a track, and
            counting it as one would make the list longer than the song. It
            sits over the timeline rather than in the header column, because
            adding a track is something you do to the arrangement — and the
            column is a list of what the song already has, not a place to put
            controls. Carries the same scroll transform as the rows, so it
            stays pinned under the last track rather than to the viewport. */}
        <Show when={props.belowTracks}>
          <div
            class="arrangement-below-tracks"
            ref={belowTracksEl}
            style={{
              left: `${HEADER_WIDTH_PX}px`,
              transform: `translateY(${-scrollTopMemo()}px)`,
              top: `${RULER_HEIGHT_PX + headerRows().length * ROW_METRICS.headerHeightPx}px`,
            }}
          >
            {props.belowTracks}
          </div>
        </Show>
      </div>
      {/* Accessible mirror: the visible tracks and the current selection as
			    real DOM, so assistive tech never has to read canvas pixels. Both
			    lists below are made entirely of track names — visually hidden is not
			    un-captured, so they are masked like any other name. */}
      <div class="visually-hidden">
        <p
          class={MASK_CONTENT}
          aria-live="polite"
          data-testid="arrangement-selection-live"
        >
          {announcement()}
        </p>
        {/* The loop brace, which is otherwise only canvas pixels (LOOP-018).
            `describeLoopBars` is the one wording of the range, and this is
            the one place it is shown: it is what a screen reader hears when
            the brace moves, and what the keyboard controls are described by. */}
        <p id={loopMirrorId} aria-live="polite" data-testid="arrangement-loop-live">
          {`Loop over ${describeLoopBars(props.project.song.loop)}, looping ${
            props.project.song.loop.enabled ? "on" : "off"
          }`}
        </p>
        <ul class={MASK_CONTENT} aria-label="Arrangement tracks">
          <For each={headerRows()}>
            {(track) => (
              <li>
                {/* The name is the item's text and `Select <name>` is the
								    control's accessible name, which contains it (WCAG
								    2.5.3). Reading the list gives the project's track
								    names, not a column of the word "Select". */}
                <button
                  type="button"
                  data-track-select={track.id}
                  aria-label={`Select ${track.name}`}
                  onClick={() => selectTrackFromList(track.rowIndex)}
                >
                  {track.name}
                </button>
              </li>
            )}
          </For>
        </ul>
        {/* Every clip, as the keyboard's way to pick one (#76). */}
        <ClipList
          entries={clipEntries()}
          selected={placementSelection()}
          active={shownClipListActive()}
          onFocusChange={(focused) => props.onClipListFocusChange?.(focused)}
        />
        {/* The placement-editing selection (ARR-002) as bare ids, for tests and
				    tooling to read. Hidden from assistive technology: the clip list
				    above says the same thing in words. */}
        <ul aria-hidden="true" data-testid="placement-selection">
          <For each={placementSelection()}>
            {(placementId) => <li data-selected-placement={placementId} />}
          </For>
        </ul>
      </div>
    </div>
  );
}
