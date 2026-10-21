/**
 * Alt-drag copy through the arrangement's pointer handlers (ARR-011): the
 * modifier is read off each pointer event through the shortcut registry's
 * `arrangement.drag_copy`, the preview follows it, and the drop decides.
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { TICKS_PER_BAR } from "../domain/time";
import { EditorSession } from "../editor/composition/EditorSession";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { createManualClock } from "../shared/clock";
import { buildArrangementProject } from "../testing/arrangementProject";
import { memoryStorage } from "../testing/storage";
import ArrangementView, { INITIAL_PIXELS_PER_TICK, ROW_METRICS } from "./ArrangementView";
import { RULER_HEIGHT_PX } from "./canvasRenderer";

afterEach(cleanup);

const BAR = TICKS_PER_BAR;
const x = (bar: number) => (bar - 0.5) * BAR * INITIAL_PIXELS_PER_TICK;
const y = (row: number) =>
  RULER_HEIGHT_PX + row * ROW_METRICS.trackHeightPx + ROW_METRICS.trackHeightPx / 2;

/** jsdom's `PointerEvent` drops coordinates, so a `MouseEvent` stands in. */
function pointer(
  canvas: Element,
  type: string,
  bar: number,
  row: number,
  altKey = false,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x(bar),
    clientY: y(row),
    altKey,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(canvas, event);
  flush();
}

/** CF-016's start: two tracks with one clip each in bar 1, both selected. */
async function setUp() {
  const { project } = buildArrangementProject([
    [{ startTicks: 0, durationTicks: BAR }],
    [{ startTicks: 0, durationTicks: BAR }],
  ]);
  const repository = createInMemoryProjectRepository();
  await repository.createProject(project);
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    deviceStorage: memoryStorage(),
  });
  const { container } = render(() => (
    <ArrangementView
      project={session.project}
      dispatch={session.dispatch.bind(session)}
      beginGesture={session.beginGesture.bind(session)}
    />
  ));
  const canvas = container.querySelector(".arrangement-layer-interactive") as HTMLElement;
  pointer(canvas, "pointerdown", 2, 0);
  pointer(canvas, "pointermove", 1, 1);
  pointer(canvas, "pointerup", 1, 1);
  expect(said()).toBe("2 clips selected");
  /** Bars (1-based) holding a clip, per track: `"1,3|1,3"`. */
  const bars = () =>
    session.project.song.tracks
      .map((track) =>
        session.project.song.placements
          .filter((p) => p.trackId === track.id)
          .map((p) => p.startTicks / BAR + 1)
          .sort()
          .join(","),
      )
      .join("|");
  return { session, canvas, bars };
}

const said = () => screen.getByTestId("arrangement-selection-live").textContent;

describe("Alt-drag in the arrangement (ARR-011)", () => {
  it("copies both selected clips, previewing the copy, and selects the copies", async () => {
    const { session, canvas, bars } = await setUp();
    pointer(canvas, "pointerdown", 1, 0, true);
    pointer(canvas, "pointermove", 3, 0, true);
    expect(canvas.style.cursor).toBe("copy");
    expect(bars()).toBe("1,3|1,3");
    pointer(canvas, "pointerup", 3, 0, true);

    expect(bars()).toBe("1,3|1,3");
    expect(canvas.style.cursor).toBe("");
    expect(said()).toBe("2 clips selected");
    expect(session.history.entries).toHaveLength(1);
  });

  it("moves the selection instead when Alt is let go before the drop", async () => {
    const { canvas, bars } = await setUp();
    pointer(canvas, "pointerdown", 1, 0, true);
    pointer(canvas, "pointermove", 3, 0, true);
    pointer(canvas, "pointermove", 3, 0, false);
    expect(canvas.style.cursor).toBe("");
    expect(bars()).toBe("3|3");
    pointer(canvas, "pointerup", 3, 0, false);
    expect(bars()).toBe("3|3");
  });

  it("copies when Alt goes down only at the drop", async () => {
    const { canvas, bars } = await setUp();
    pointer(canvas, "pointerdown", 1, 0);
    pointer(canvas, "pointermove", 3, 0);
    pointer(canvas, "pointerup", 3, 0, true);
    expect(bars()).toBe("1,3|1,3");
  });

  it("keeps the browser off the bare Alt key during the drag, and after it", async () => {
    const { canvas } = await setUp();
    const key = (type: "keydown" | "keyup") => {
      const event = new KeyboardEvent(type, { key: "Alt", cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(key("keydown")).toBe(false);
    pointer(canvas, "pointerdown", 1, 0, true);
    expect(key("keydown")).toBe(true);
    pointer(canvas, "pointermove", 3, 0, true);
    pointer(canvas, "pointerup", 3, 0, true);
    // Still held at the drop: its release is the one the browser would act on.
    expect(key("keyup")).toBe(true);
    expect(key("keydown")).toBe(false);
  });
});

describe("the resize cursor on a clip's edge (#493)", () => {
  /** A point `px` pixels left of bar `bar`'s end (1-based), on `row`. */
  function at(canvas: Element, type: string, bar: number, px: number, altKey = false) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: bar * BAR * INITIAL_PIXELS_PER_TICK - px,
      clientY: y(0),
      altKey,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(canvas, event);
    flush();
  }

  it("shows while hovering the edge, and not over the body or empty space", async () => {
    const { canvas } = await setUp();
    at(canvas, "pointermove", 1, 1);
    expect(canvas.style.cursor).toBe("ew-resize");
    pointer(canvas, "pointermove", 1, 0);
    expect(canvas.style.cursor).toBe("");
    pointer(canvas, "pointermove", 3, 0);
    expect(canvas.style.cursor).toBe("");
  });

  it("stays through an edge drag, with or without Alt, and clears at the drop", async () => {
    const { canvas } = await setUp();
    at(canvas, "pointerdown", 1, 1);
    at(canvas, "pointermove", 3, 1, true);
    expect(canvas.style.cursor).toBe("ew-resize");
    at(canvas, "pointerup", 3, 1);
    expect(canvas.style.cursor).toBe("");
  });
});
