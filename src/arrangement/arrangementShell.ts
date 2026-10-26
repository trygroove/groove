/**
 * The framework-free arrangement editor shell controller (`ARR-001`; PRD
 * ARR-01, section 9.3).
 *
 * This is the production successor to the FND-008 spike's ad-hoc component
 * state (`spike/ArrangementSpike.tsx`), lifted out of SolidJS so the shell's
 * behavior — viewport transform, dirty-layer bookkeeping, culling ranges,
 * pointer-anchored zoom, scrollbar/resize/DPR synchronization, playhead-follow,
 * and the named accessibility actions — is unit-testable
 * without a DOM, a Canvas, or a reactive runtime. `ArrangementView.tsx` is the
 * thin Solid adapter that installs canvases and DOM controls on top of it.
 *
 * It holds no domain state and issues no commands: it consumes a read-only
 * `ArrangementProjection` and reports what to draw. It holds no selection
 * either: the arrangement's one selection (#292) lives with placement editing,
 * and the shell only frames a span of it on request. Placement editing
 * (`ARR-002`), sections (`ARR-003`), and automation editing (`ARR-004`) build
 * their transient gestures on top of this shell.
 */

import type { PlacementId } from "../domain/ids";
import {
  pixelsToTicks,
  type RowRange,
  rowIndexAtOffset,
  type TickRange,
  type Viewport,
  visibleRowRange,
  visibleTickRange,
  zoomAtAnchor,
} from "./geometry";
import { type ArrangementProjection, hitTestArrangement } from "./projection";

/** The three stacked canvases, each with its own dirty reason (PRD 9.3). */
export type DirtyLayer = "background" | "content" | "interaction";

export interface ArrangementShellConfig {
  /** CSS pixels of overscan applied to the visible tick range for culling. */
  readonly overscanPx: number;
  /** Rows of overscan applied to the visible row range for header windowing. */
  readonly overscanRows: number;
  readonly minPixelsPerTick: number;
  readonly maxPixelsPerTick: number;
  /** Resize-handle hit width in CSS pixels (constant regardless of zoom). */
  readonly resizeHandlePx: number;
  /** Device-pixel-ratio cap for canvas backing stores (PRD 9.3: capped at 2). */
  readonly maxDevicePixelRatio: number;
  /**
   * Playhead follow turns the page once the playhead comes this close, in CSS
   * pixels, to the right edge of the view, so it never reaches the edge (#964).
   */
  readonly followEdgePx: number;
  /** Where a page turn puts the playhead: this far in from the left edge. */
  readonly followLeadPx: number;
  /**
   * CSS pixels of scrollable height beyond the rows themselves: the ruler
   * above them and any clearance kept below the last one. The scroll range is
   * the rows plus this, so it matches the spacer the native scroller measures
   * (#959) and the last row can be scrolled clear of anything floating over
   * the bottom of the viewport.
   */
  readonly extraHeightPx: number;
}

export const DEFAULT_SHELL_CONFIG: ArrangementShellConfig = {
  overscanPx: 200,
  overscanRows: 4,
  minPixelsPerTick: 0.01,
  maxPixelsPerTick: 2,
  resizeHandlePx: 6,
  maxDevicePixelRatio: 2,
  followEdgePx: 24,
  followLeadPx: 24,
  extraHeightPx: 0,
};

export interface ArrangementShellState {
  readonly viewport: Viewport;
  readonly playheadTicks: number;
  readonly hoverPlacementId: PlacementId | null;
  /** Whether the playhead is kept in view as it advances (PRD 9.3 follow). */
  readonly playheadFollow: boolean;
}

/** How far the pointer moved in CSS pixels; sign follows scroll direction. */
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** ctrl/cmd held: the desktop convention for pinch-zoom over the timeline. */
  readonly zoom: boolean;
  /** Viewport-local x the zoom must stay anchored to. */
  readonly anchorX: number;
}

const KEYBOARD_ZOOM_STEP = 1.25;

/**
 * Constructs the shell controller for one open arrangement. Callers subscribe
 * to layer invalidations through `onDirty` and read `getState()`/derived
 * ranges; every mutator marks exactly the layers whose pixels changed, so a
 * playhead advance never invalidates the grid or clip content (PRD 9.3
 * "explicit dirty reasons").
 */
export function createArrangementShell(
  getProjection: () => ArrangementProjection,
  options: {
    readonly initialViewport: Viewport;
    readonly config?: Partial<ArrangementShellConfig>;
    /** Notified with the set of layers that became dirty since last drawn. */
    readonly onDirty: (layers: ReadonlySet<DirtyLayer>) => void;
  },
) {
  const config: ArrangementShellConfig = {
    ...DEFAULT_SHELL_CONFIG,
    ...options.config,
  };

  let viewport = options.initialViewport;
  let playheadTicks = 0;
  let hoverPlacementId: PlacementId | null = null;
  let playheadFollow = true;
  // The furthest tick a zoom or a playhead-follow page turn has framed. The
  // timeline can scroll to here even when it is past the end of the song, so
  // a range that runs beyond the last clip can still be shown edge to edge
  // (#292, CF-011), and a playhead playing on past the last clip stays in view
  // (#964).
  let framedExtentTicks = 0;
  let extraHeightPx = config.extraHeightPx;

  const dirty = new Set<DirtyLayer>();

  function markDirty(...layers: DirtyLayer[]): void {
    for (const layer of layers) dirty.add(layer);
    options.onDirty(dirty);
  }

  /** Drains the accumulated dirty set — the renderer calls this once per
   * animation frame and draws exactly the layers it returns. */
  function takeDirty(): Set<DirtyLayer> {
    const drained = new Set(dirty);
    dirty.clear();
    return drained;
  }

  /** The full scrollable height: every row, plus the ruler and clearance. */
  function contentHeight(): number {
    const offsets = getProjection().rowOffsets;
    return (offsets[offsets.length - 1] ?? 0) + extraHeightPx;
  }

  /** How far the timeline runs: the song, or further if a zoom framed more. */
  function contentLengthTicks(): number {
    return Math.max(getProjection().lengthTicks, framedExtentTicks);
  }

  function maxScrollLeft(): number {
    return Math.max(0, contentLengthTicks() * viewport.pixelsPerTick - viewport.width);
  }

  function maxScrollTop(): number {
    return Math.max(0, contentHeight() - viewport.height);
  }

  function clampScrollLeft(value: number): number {
    return Math.max(0, Math.min(maxScrollLeft(), value));
  }

  function clampScrollTop(value: number): number {
    return Math.max(0, Math.min(maxScrollTop(), value));
  }

  function setViewport(next: Viewport): void {
    viewport = next;
  }

  /** The tick range to cull to: only visible content plus a small overscan. */
  function tickRange(): TickRange {
    return visibleTickRange(viewport, config.overscanPx);
  }

  /** The row range to draw / window headers to: visible rows plus overscan. */
  function rowRange(): RowRange {
    return visibleRowRange(getProjection().rowOffsets, viewport, config.overscanRows);
  }

  function devicePixelRatio(hostRatio: number): number {
    return Math.min(config.maxDevicePixelRatio, Math.max(1, hostRatio || 1));
  }

  function setScroll(scrollLeft: number, scrollTop: number): void {
    const nextLeft = clampScrollLeft(scrollLeft);
    const nextTop = clampScrollTop(scrollTop);
    if (nextLeft === viewport.scrollLeft && nextTop === viewport.scrollTop) {
      return;
    }
    setViewport({ ...viewport, scrollLeft: nextLeft, scrollTop: nextTop });
    markDirty("background", "content", "interaction");
  }

  /** Resize / DPR change: canvases resize, everything redraws. Idempotent —
   * an identical size marks nothing dirty (PRD 9.3 "idle when no pixels
   * change"). */
  function resize(width: number, height: number): void {
    const nextWidth = Math.max(0, Math.round(width));
    const nextHeight = Math.max(0, Math.round(height));
    if (nextWidth === viewport.width && nextHeight === viewport.height) return;
    // Apply the new dimensions first, so the scroll clamp is computed against
    // the new viewport size — a taller viewport can reveal content that was
    // scrolled past and must pull scrollTop back down.
    setViewport({ ...viewport, width: nextWidth, height: nextHeight });
    setViewport({
      ...viewport,
      scrollLeft: clampScrollLeft(viewport.scrollLeft),
      scrollTop: clampScrollTop(viewport.scrollTop),
    });
    markDirty("background", "content", "interaction");
  }

  function zoomAt(anchorX: number, nextPixelsPerTick: number): void {
    const clamped = Math.max(
      config.minPixelsPerTick,
      Math.min(config.maxPixelsPerTick, nextPixelsPerTick),
    );
    if (clamped === viewport.pixelsPerTick) return;
    const result = zoomAtAnchor({
      viewport,
      nextPixelsPerTick: clamped,
      anchorX,
    });
    setViewport({
      ...viewport,
      pixelsPerTick: result.pixelsPerTick,
      scrollLeft: clampScrollLeft(result.scrollLeft),
    });
    markDirty("background", "content", "interaction");
  }

  /** Keyboard zoom-in, anchored at the viewport centre. */
  function zoomIn(): void {
    zoomAt(viewport.width / 2, viewport.pixelsPerTick * KEYBOARD_ZOOM_STEP);
  }

  function zoomOut(): void {
    zoomAt(viewport.width / 2, viewport.pixelsPerTick / KEYBOARD_ZOOM_STEP);
  }

  /**
   * Frame `[startTicks, endTicks)` exactly: the zoom that makes it span the
   * viewport width, scrolled so it starts at the left edge (KEY-01
   * `view.zoom_to_selection`). A span wider or narrower than the zoom limits
   * allow is framed as closely as they permit, from its start.
   */
  function zoomToSpan(startTicks: number, endTicks: number): void {
    const spanTicks = Math.max(1, endTicks - startTicks);
    const nextPixelsPerTick = Math.max(
      config.minPixelsPerTick,
      Math.min(config.maxPixelsPerTick, viewport.width / spanTicks),
    );
    framedExtentTicks = Math.max(framedExtentTicks, endTicks);
    setViewport({ ...viewport, pixelsPerTick: nextPixelsPerTick });
    const scrollLeft = clampScrollLeft(startTicks * nextPixelsPerTick);
    setViewport({ ...viewport, scrollLeft });
    markDirty("background", "content", "interaction");
  }

  /**
   * Keep the playhead in view (KEY-01 follow / the "scroll to playhead" named
   * action). It pages, the way Live's follow does: while the playhead is
   * inside the view the view stands still, and once it nears the right edge,
   * or is anywhere outside the view, the view jumps so the playhead sits just
   * in from the left edge and walks across the new page (#964). A page turn
   * past the end of the song extends the timeline that far, so a playhead
   * playing on after the last clip is not left behind the scroll limit.
   * Vertical scroll is unaffected.
   */
  function scrollToPlayhead(): void {
    // A view not laid out yet has nothing to keep the playhead in.
    if (viewport.width <= 0) return;
    // A view too narrow for both margins splits it rather than paging forever.
    const edge = Math.min(config.followEdgePx, viewport.width / 4);
    const lead = Math.min(config.followLeadPx, viewport.width / 4);
    const x = playheadTicks * viewport.pixelsPerTick;
    if (x >= viewport.scrollLeft && x <= viewport.scrollLeft + viewport.width - edge) {
      return;
    }
    const nextLeft = Math.max(0, x - lead);
    framedExtentTicks = Math.max(
      framedExtentTicks,
      (nextLeft + viewport.width) / viewport.pixelsPerTick,
    );
    setScroll(nextLeft, viewport.scrollTop);
  }

  /**
   * Scroll as little as it takes to show `[startTicks, endTicks)`, the way a
   * focused control is kept on screen: a span already in view leaves the view
   * alone, one past an edge is brought to it, and one wider than the view is
   * aligned by its start. A span past the end of the song extends the timeline
   * that far, so the scroll limit never hides it.
   */
  function revealSpan(startTicks: number, endTicks: number): void {
    if (viewport.width <= 0) return;
    const left = startTicks * viewport.pixelsPerTick;
    const right = endTicks * viewport.pixelsPerTick;
    framedExtentTicks = Math.max(framedExtentTicks, endTicks);
    let next = viewport.scrollLeft;
    if (left < next || right - left > viewport.width) next = left;
    else if (right > next + viewport.width) next = right - viewport.width;
    setScroll(next, viewport.scrollTop);
  }

  function seekTo(ticks: number): void {
    const next = Math.max(0, ticks);
    if (next === playheadTicks) return;
    playheadTicks = next;
    markDirty("interaction");
    if (playheadFollow) scrollToPlayhead();
  }

  function setPlayheadFollow(follow: boolean): void {
    playheadFollow = follow;
  }

  function setHover(placementId: PlacementId | null): void {
    if (placementId === hoverPlacementId) return;
    hoverPlacementId = placementId;
    markDirty("interaction");
  }

  function handleWheel(input: WheelInput): void {
    if (input.zoom) {
      const zoomFactor = Math.exp(-input.deltaY * 0.01);
      zoomAt(input.anchorX, viewport.pixelsPerTick * zoomFactor);
    } else {
      setScroll(viewport.scrollLeft + input.deltaX, viewport.scrollTop + input.deltaY);
    }
  }

  /** Viewport-local pixel -> {rowIndex, tick} through the same transforms the
   * renderer draws with, so pointer and pixels never disagree (PRD 9.3). */
  function pointToArrangement(localX: number, localY: number) {
    const tick = pixelsToTicks(viewport.scrollLeft + localX, viewport);
    const rowIndex = rowIndexAtOffset(
      getProjection().rowOffsets,
      viewport.scrollTop + localY,
    );
    return { tick, rowIndex };
  }

  function hitTestAt(localX: number, localY: number) {
    const { tick, rowIndex } = pointToArrangement(localX, localY);
    const handleWidthTicks = pixelsToTicks(config.resizeHandlePx, viewport);
    return hitTestArrangement(getProjection(), { rowIndex, tick }, handleWidthTicks);
  }

  /** Pointer hover: hit-test the visible track and light up a placement. */
  function handlePointerMove(localX: number, localY: number): void {
    const result = hitTestAt(localX, localY);
    setHover(result.kind === "placement" ? result.placementId : null);
  }

  function clearHover(): void {
    setHover(null);
  }

  function getState(): ArrangementShellState {
    return {
      viewport,
      playheadTicks,
      hoverPlacementId,
      playheadFollow,
    };
  }

  /** The space below the rows changed size (the add-track unit wrapped onto
   * another line, say): re-clamp scroll to the new bottom. */
  function setExtraHeight(px: number): void {
    const next = Math.max(0, px);
    if (next === extraHeightPx) return;
    extraHeightPx = next;
    setScroll(viewport.scrollLeft, viewport.scrollTop);
  }

  /** Everything changed (project identity / track count): redraw all layers,
   * re-clamping scroll to the new content bounds. */
  function invalidateAll(): void {
    setViewport({
      ...viewport,
      scrollLeft: clampScrollLeft(viewport.scrollLeft),
      scrollTop: clampScrollTop(viewport.scrollTop),
    });
    markDirty("background", "content", "interaction");
  }

  return {
    config,
    getState,
    getViewport: () => viewport,
    tickRange,
    rowRange,
    devicePixelRatio,
    takeDirty,
    markDirty,
    setScroll,
    resize,
    zoomAt,
    zoomIn,
    zoomOut,
    zoomToSpan,
    contentLengthTicks,
    contentHeight,
    setExtraHeight,
    scrollToPlayhead,
    revealSpan,
    seekTo,
    setPlayheadFollow,
    setHover,
    clearHover,
    handleWheel,
    handlePointerMove,
    hitTestAt,
    pointToArrangement,
    invalidateAll,
  };
}

export type ArrangementShell = ReturnType<typeof createArrangementShell>;
