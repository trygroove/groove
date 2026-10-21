import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { TrackId } from "../../domain/ids";
import { useShortcutScope } from "../../shortcuts/useShortcutScope";
import { createSlide, type DragLift, liftItem } from "./dragLift";
import "./dragLift.css";
import { dropSlot, slotToIndex } from "./trackActions";

/**
 * Drag a track to a new position (TRK-02, #331). The arrangement's header
 * column and the mixer's strip row share this controller, each along its axis,
 * and so does a device chain (#539): `Id` is whatever the list's items are keyed
 * by, and an item is any element carrying its id in `data-track-drag`.
 *
 * Nothing touches the project mid-drag: the drag publishes where the track
 * *would* land as `target`, and a view previews it there. Letting go inside the
 * zone calls `onDrop` once — one `track.reorder`, one revision, one history
 * entry; letting go anywhere else, or where the track already is, calls nothing.
 *
 * The track is picked up (#539, `dragLift.ts`): a copy follows the pointer, its
 * own slot is the gap the preview leaves, and the other items slide aside.
 * Escape, or a cancelled pointer, puts it back and calls nothing.
 *
 * Items are read off the DOM by `data-track-drag` (the arrangement renders only
 * the rows in view), placed in the whole song by `indexOf`, and measured once
 * at drag start, since the preview moves them.
 */
export interface TrackDragOptions<Id extends string = TrackId> {
  readonly axis: "x" | "y";
  /** The element that bounds a valid drop. */
  zone(): HTMLElement | undefined;
  /** A track's position in display order. */
  indexOf(trackId: Id): number;
  onDrop(trackId: Id, toIndex: number): void;
}

export interface TrackDrag<Id extends string = TrackId> {
  /** Start a drag from a handle's `pointerdown`. */
  begin(event: PointerEvent, trackId: Id): void;
  /** The track being dragged, once the pointer has passed the threshold. */
  readonly dragging: Accessor<Id | null>;
  /** The display index letting go now would move the dragged track to, or
   * null when it would change nothing. */
  readonly target: Accessor<number | null>;
}

/** How far the pointer travels before a press becomes a drag, in px. */
const DRAG_THRESHOLD_PX = 4;

export function useTrackDrag<Id extends string = TrackId>(
  options: TrackDragOptions<Id>,
): TrackDrag<Id> {
  const [dragging, setDragging] = createSignal<Id | null>(null);
  const [targetIndex, setTargetIndex] = createSignal<number | null>(null);
  let teardown: (() => void) | null = null;
  const slide = createSlide();
  /** The zone's items but the held one, whose slot is the hidden gap. */
  const items = (zone: HTMLElement, held: Id) =>
    [...zone.querySelectorAll<HTMLElement>("[data-track-drag]")].filter(
      (el) => el.dataset.trackDrag !== held,
    );
  // The other items slide to wherever the preview has just put them. Every
  // read is in the compute half; the DOM has settled by the time apply runs.
  // The zone is read only while a drag is held: a caller's zone is usually a
  // ref declared after this hook runs, so reading it at setup would throw.
  createEffect(
    () => {
      const held = dragging();
      return [targetIndex(), held, held === null ? undefined : options.zone()] as const;
    },
    ([, held, zone]) => {
      if (held !== null && zone) slide.settle(items(zone, held));
    },
  );

  // Escape puts the held track back (`view.close_surface`, never a key read here).
  let cancelDrag: (() => void) | null = null;
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => cancelDrag?.(),
        isEnabled: () => dragging() !== null,
      },
    }),
    contexts: () => [],
  });

  const y = options.axis === "y";

  /** A client position along the axis, in the zone's scrolled content — so a
   * measurement taken at drag start stays valid while the zone scrolls. */
  function along(zone: HTMLElement, client: number): number {
    const box = zone.getBoundingClientRect();
    return client - (y ? box.top : box.left) + (y ? zone.scrollTop : zone.scrollLeft);
  }

  type Item = { readonly index: number; readonly middle: number };

  function measure(zone: HTMLElement): Item[] {
    return [...zone.querySelectorAll<HTMLElement>("[data-track-drag]")].map((el) => {
      const r = el.getBoundingClientRect();
      const id = el.dataset.trackDrag as Id;
      const middle = along(zone, y ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2);
      return { index: options.indexOf(id), middle };
    });
  }

  /** The display index letting go at `event` would move the track to. */
  function target(event: PointerEvent, zone: HTMLElement, from: number, items: Item[]) {
    const box = zone.getBoundingClientRect();
    const { clientX: px, clientY: py } = event;
    const inside = px >= box.left && px <= box.right && py >= box.top && py <= box.bottom;
    const last = items.at(-1);
    if (!inside || !last) return null;
    const middles = items.map(({ middle }) => middle);
    const k = dropSlot(along(zone, y ? py : px), middles);
    const toIndex = slotToIndex(from, k < items.length ? items[k].index : last.index + 1);
    return toIndex === from ? null : toIndex;
  }

  function end(): void {
    teardown?.();
    teardown = null;
    setTargetIndex(null);
    setDragging(null);
  }

  function begin(event: PointerEvent, trackId: Id): void {
    const zone = options.zone();
    if (event.button !== 0 || !zone) return;
    end();
    const fromIndex = options.indexOf(trackId);
    const origin = { x: event.clientX, y: event.clientY };
    let active = false;
    let toIndex: number | null = null;
    let measured: Item[] = [];
    let lift: DragLift | null = null;

    const onMove = (move: PointerEvent) => {
      if (!active) {
        const moved = Math.hypot(move.clientX - origin.x, move.clientY - origin.y);
        if (moved < DRAG_THRESHOLD_PX) return;
        active = true;
        measured = measure(zone);
        slide.settle(items(zone, trackId));
        const source = zone.querySelector<HTMLElement>(
          `[data-track-drag="${CSS.escape(trackId)}"]`,
        );
        lift = source ? liftItem(source, event) : null;
        setDragging(() => trackId);
      }
      lift?.move(move);
      toIndex = target(move, zone, fromIndex, measured);
      setTargetIndex(toIndex);
    };
    const onUp = () => {
      const drop = active ? toIndex : null;
      if (active) swallowNextClick();
      lift?.dispose();
      end();
      if (drop !== null) options.onDrop(trackId, drop);
    };
    const onCancel = () => {
      lift?.dispose();
      end();
    };
    // Escape while still held: the release that follows must not click-select.
    cancelDrag = () => {
      onCancel();
      window.addEventListener("pointerup", swallowNextClick, {
        once: true,
        capture: true,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      lift?.dispose();
      cancelDrag = null;
    };
  }

  onCleanup(() => teardown?.());

  return { begin, dragging, target: targetIndex };
}

/**
 * A drag still ends in a `click`, which would select the track. Swallow it; it
 * comes right after `pointerup` if at all, so a new task or press ends the wait.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    stop();
  };
  const stop = () => {
    window.removeEventListener("click", swallow, { capture: true });
    window.removeEventListener("pointerdown", stop, { capture: true });
  };
  window.addEventListener("click", swallow, { capture: true });
  window.addEventListener("pointerdown", stop, { capture: true });
  setTimeout(stop, 0);
}
