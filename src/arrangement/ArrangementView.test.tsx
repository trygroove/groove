import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { CommandHistory } from "../commands";
import { setLoopRange } from "../commands/definitions/loop";
import type { Project } from "../domain/entities";
import {
  createLargeArrangementProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import type { PlacementId, TrackId } from "../domain/ids";
import { TICKS_PER_BAR, toTicks } from "../domain/time";
import { EditorSession } from "../editor/composition/EditorSession";
import { orderedTrackIds } from "../editor/tracks/trackActions";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import { createManualClock } from "../shared/clock";
import { detectPlatform, shortcutLabel } from "../shortcuts";
import { buildArrangementProject } from "../testing/arrangementProject";
import { clickAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import { dragTrackHandle, stubTrackDragLayout } from "../testing/trackDrag";
import ArrangementView, {
  HEADER_WIDTH_PX,
  INITIAL_PIXELS_PER_TICK,
  type PlacementEditingActions,
  ROW_METRICS,
} from "./ArrangementView";
import { RULER_HEIGHT_PX } from "./canvasRenderer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The scale the view opens at, not a copy of it: a coordinate built from a
// number written down here goes stale silently the moment the default zoom
// moves, and the click lands on whatever happens to be under it instead.
const PIXELS_PER_TICK = INITIAL_PIXELS_PER_TICK;
// The view's own metric, not a copy of it: these coordinates only mean
// anything if they agree with the rows actually being drawn.
const ROW_HEIGHT_PX = ROW_METRICS.trackHeightPx;

/** jsdom's `PointerEvent` drops `clientX`/`button`; a `MouseEvent` bubbles to
 * the same `onPointer*` handlers and carries them, exactly like `PianoRoll`'s
 * own test helper does for the same reason. */
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  fireEvent(el, event);
  flush();
}

/** A one-placement fixture wired to a real `EditorSession`, so a test asserts
 * against the project a gesture actually produced (mirrors `PianoRoll.test.tsx`
 * and the `placementEditingHarness`'s own approach). */
async function setUpEditing(
  project: Project = createSliceFixtureProject(),
  options: { analyticsEnabled?: boolean } = {},
) {
  const repository = createInMemoryProjectRepository();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture failed to create");

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.analyticsEnabled === false) consent.optOut();
  else consent.optIn();
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });

  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });

  function renderView(
    onOpenPlacement?: (placementId: PlacementId) => void,
    onSelectPlacement?: (placementId: PlacementId) => void,
    onSeekTicks?: (ticks: number) => void,
  ) {
    return render(() => (
      <ArrangementView
        onSeekTicks={onSeekTicks}
        project={session.project}
        analytics={analytics}
        dispatch={session.dispatch.bind(session)}
        beginGesture={session.beginGesture.bind(session)}
        onOpenPlacement={onOpenPlacement}
        onSelectPlacement={onSelectPlacement}
      />
    ));
  }

  return {
    session,
    transport,
    renderView,
    placementId: project.song.placements[0].id,
  };
}

function interactionCanvasOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".arrangement-layer-interactive");
  if (!el) throw new Error("no interaction canvas rendered");
  return el as HTMLElement;
}

function selectedPlacementIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-selected-placement]")).map(
    (el) => el.getAttribute("data-selected-placement") as string,
  );
}

/** An `Analytics` that actually sends (consent granted, memory storage), with a
 * recording transport so tests can assert exactly what was logged. */
function analyticsAllowing() {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  consent.optIn();
  const analytics = new Analytics({
    transport,
    consent,
    releaseSha: "test0000test0000",
    surface: "editor",
    storage: memoryStorage(),
  });
  return { analytics, transport };
}

function renderView(analytics: Analytics) {
  const project = createLargeArrangementProject(20);
  return render(() => <ArrangementView project={project} analytics={analytics} />);
}

describe("ArrangementView shell", () => {
  it("floats a four-button, icon-only zoom group, top to bottom, with the keys as tooltips", () => {
    const { analytics } = analyticsAllowing();
    renderView(analytics);
    const group = screen.getByRole("group", { name: "Zoom" });
    const buttons = within(group).getAllByRole("button");
    const platform = detectPlatform();
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Zoom to arrangement",
      "Zoom to selection",
      "Zoom in",
      "Zoom out",
    ]);
    // Icons only: no button carries visible text, and each tooltip names its key
    // as the registry spells it.
    for (const button of buttons) expect(button).toHaveTextContent("");
    expect(buttons.map((button) => button.getAttribute("title"))).toEqual([
      `Zoom to arrangement (${shortcutLabel("view.zoom_to_arrangement", platform)})`,
      `Zoom to selection (${shortcutLabel("view.zoom_to_selection", platform)})`,
      `Zoom in (${shortcutLabel("view.zoom_in", platform)})`,
      `Zoom out (${shortcutLabel("view.zoom_out", platform)})`,
    ]);
    // Zoom to selection has nothing to frame yet; the others always work.
    expect(buttons.map((button) => (button as HTMLButtonElement).disabled)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // Scroll to playhead is keyboard-only now, and the old toolbar is gone.
    expect(screen.queryByRole("button", { name: "Scroll to playhead" })).toBeNull();
    expect(document.querySelector(".arrangement-toolbar")).toBeNull();
  });

  /** UI-001/CF-004: a clip is canvas pixels with no node to aim at, so the
   * timeline publishes its own scale and a browser test turns a bar into the
   * pixel a gesture lands on — rather than hard-coding the starting zoom. */
  it("publishes the timeline's horizontal scale, and keeps it current as it zooms", () => {
    const { analytics } = analyticsAllowing();
    const { container } = renderView(analytics);
    const root = container.querySelector(".arrangement-view");
    const scaleOf = () => Number(root?.getAttribute("data-pixels-per-tick"));
    expect(scaleOf()).toBeGreaterThan(0);

    const before = scaleOf();
    clickAndFlush(screen.getByLabelText("Zoom in"));
    expect(scaleOf()).toBeGreaterThan(before);
  });

  it("hands the header column's width to its stylesheet as a custom property (GRV-105)", () => {
    // Not a `style={{ width }}` entry: Solid folds a constant one into the
    // template as a `style` attribute, which a strict CSP refuses.
    const { analytics } = analyticsAllowing();
    const { container } = renderView(analytics);
    const body = container.querySelector(".arrangement-body") as HTMLElement;
    expect(body.style.getPropertyValue("--track-column-width")).toBe(
      `${HEADER_WIDTH_PX}px`,
    );
  });

  it("windows the DOM track headers rather than rendering one per track", () => {
    const { analytics } = analyticsAllowing();
    // 50 tracks at 28px is 1,400px of content; the default 480px viewport
    // windows to roughly 21 rows (+ overscan), well under all 50.
    const project = createLargeArrangementProject(50);
    render(() => <ArrangementView project={project} analytics={analytics} />);
    const headerList = screen.getByLabelText("Tracks");
    const rows = headerList.querySelectorAll(".arrangement-header-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
  });

  it("exposes an accessible per-track select control (canvas is not the sole representation)", () => {
    const { analytics } = analyticsAllowing();
    renderView(analytics);
    const list = screen.getByLabelText("Arrangement tracks");
    const buttons = list.querySelectorAll("button[data-track-select]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("selecting a track from the accessible list updates the live selection region", async () => {
    const { analytics } = analyticsAllowing();
    renderView(analytics);
    const list = screen.getByLabelText("Arrangement tracks");
    const firstSelect = list.querySelector<HTMLButtonElement>(
      "button[data-track-select]",
    );
    if (!firstSelect) throw new Error("no track-select control rendered");
    clickAndFlush(firstSelect);
    // The list selects the clips in the track's first bar (#292): here the
    // large fixture's first clip, which runs across bars 1 and 2.
    const live = screen.getByTestId("arrangement-selection-live");
    expect(live.textContent).toBe("Selected clip on Loop 1, bars 1 to 2");
  });
});

describe("arrangement feature_first_use analytics (PRD OPS-02)", () => {
  it("fires arrangement feature_first_use exactly once, on the first interaction", () => {
    const { analytics, transport } = analyticsAllowing();
    renderView(analytics);
    // No interaction yet: nothing logged.
    expect(featureUses(transport)).toEqual([]);

    clickAndFlush(screen.getByLabelText("Zoom in"));
    expect(featureUses(transport)).toEqual(["arrangement"]);

    // Further interactions do not re-fire it.
    clickAndFlush(screen.getByLabelText("Zoom out"));
    clickAndFlush(screen.getByLabelText("Zoom in"));
    expect(featureUses(transport)).toEqual(["arrangement"]);
  });

  it("logs nothing when analytics consent is denied", () => {
    const transport = createRecordingTransport();
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const analytics = new Analytics({
      transport,
      consent,
      releaseSha: "test0000test0000",
      surface: "editor",
      storage: memoryStorage(),
    });
    renderView(analytics);
    clickAndFlush(screen.getByLabelText("Zoom in"));
    clickAndFlush(screen.getByLabelText("Zoom out"));
    expect(transport.events).toEqual([]);
  });
});

function featureUses(transport: ReturnType<typeof createRecordingTransport>): string[] {
  return transport.events
    .filter((event) => event.name === "feature_first_use")
    .map((event) => event.params.feature as string);
}

describe("placement editing wiring (ARR-002)", () => {
  it("pointer-down on a placement selects it, not the shell's bar range", async () => {
    const { renderView, placementId } = await setUpEditing();
    const { container } = renderView();
    const canvas = interactionCanvasOf(container);
    // The fixture's one placement spans tick 0..TICKS_PER_BAR at row 0; a
    // point mid-body, well clear of the resize handles, hits its body.
    firePointer(canvas, "pointerdown", {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });
    firePointer(canvas, "pointerup", { clientX: 0, clientY: 0 });
    expect(selectedPlacementIds(container)).toEqual([placementId]);
  });

  /**
   * The preview showed two cyan boxes on one track at once: the shell's ARR-01
   * bar range and the ARR-002 placement selection, each left standing by the
   * click that made the other. "There should only be a single selection."
   */
  it("keeps exactly one arrangement selection live at a time", async () => {
    const { renderView, placementId } = await setUpEditing();
    const { container } = renderView();
    const canvas = interactionCanvasOf(container);
    const rowY = RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2;
    const barRangeText = () =>
      screen.getByTestId("arrangement-selection-live").textContent;
    const clickAt = (ticks: number) => {
      firePointer(canvas, "pointerdown", {
        clientX: ticks * PIXELS_PER_TICK,
        clientY: rowY,
      });
      firePointer(canvas, "pointerup", { clientX: 0, clientY: 0 });
    };

    // Empty space, three bars along: a point is the selection.
    clickAt(TICKS_PER_BAR * 3);
    expect(barRangeText()).toBe("Position 4.1.1");

    // The placement now becomes the only selection, and is announced as one
    // (#292: it used to be silent, reading "No selection").
    clickAt(TICKS_PER_BAR / 2);
    expect(selectedPlacementIds(container)).toEqual([placementId]);
    expect(barRangeText()).toBe("Selected clip on BD, bar 1");

    // And back out to empty space: the point is the only one again.
    clickAt(TICKS_PER_BAR * 3);
    expect(barRangeText()).toBe("Position 4.1.1");
    expect(selectedPlacementIds(container)).toEqual([]);
  });

  it("dragging a placement's body moves it, bar-snapped, through the command layer", async () => {
    const { session, renderView, placementId } = await setUpEditing();
    const { container } = renderView();
    const canvas = interactionCanvasOf(container);
    const bodyY = RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2;

    firePointer(canvas, "pointerdown", {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: bodyY,
    });
    // Drag three bars to the right.
    const targetTicks = TICKS_PER_BAR / 2 + TICKS_PER_BAR * 3;
    firePointer(canvas, "pointermove", {
      clientX: targetTicks * PIXELS_PER_TICK,
      clientY: bodyY,
    });
    firePointer(canvas, "pointerup", {
      clientX: targetTicks * PIXELS_PER_TICK,
      clientY: bodyY,
    });

    const placement = session.project.song.placements.find((p) => p.id === placementId);
    expect(placement?.startTicks).toBe(TICKS_PER_BAR * 3);
    // The whole drag is one history entry, not one per pointermove.
    expect(session.history.entries.length).toBe(1);
  });

  it("exposes the controller's operations through onEditingActionsReady, like registerPianoRollActions", async () => {
    const { session, placementId } = await setUpEditing();
    const holder: { current: PlacementEditingActions | null } = {
      current: null,
    };
    render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        beginGesture={session.beginGesture.bind(session)}
        onEditingActionsReady={(actions) => {
          holder.current = actions;
        }}
      />
    ));
    expect(holder.current).not.toBeNull();
    holder.current?.select(placementId);
    expect(holder.current?.hasSelection()).toBe(true);
  });

  it("has no placement toolbar: duplication is Cmd/Ctrl+D and the right-edge drag (#493)", async () => {
    const { renderView } = await setUpEditing();
    renderView();
    expect(screen.queryByTestId("placement-toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/Duplicate as/)).not.toBeInTheDocument();
  });

  it("linked duplicate reuses the source clip; independent duplicate forks a new one", async () => {
    const { session, placementId } = await setUpEditing();
    const holder: { current: PlacementEditingActions | null } = { current: null };
    render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        beginGesture={session.beginGesture.bind(session)}
        onEditingActionsReady={(actions) => {
          holder.current = actions;
        }}
      />
    ));
    holder.current?.select(placementId);

    const originalClipCount = session.project.clips.length;
    const sourcePlacement = session.project.song.placements.find(
      (p) => p.id === placementId,
    );

    holder.current?.duplicate("linked");
    expect(session.project.clips.length).toBe(originalClipCount);
    expect(session.project.song.placements.length).toBe(2);
    const linkedCopy = session.project.song.placements.find((p) => p.id !== placementId);
    expect(linkedCopy?.clipId).toBe(sourcePlacement?.clipId);

    // The linked copy is now the selection, so this forks it into the next bar.
    holder.current?.duplicate("independent");
    expect(session.project.clips.length).toBe(originalClipCount + 1);
    expect(session.project.song.placements.length).toBe(3);
  });
});

/**
 * `UI-001` moves sequencing into an editor opened *from a clip*, so the
 * arrangement has to report that gesture. It reports it and nothing more — what
 * opening a clip means belongs to the editor, which is why these tests assert a
 * callback rather than a surface.
 */
describe("opening a placement (UI-001)", () => {
  it("reports a double-click on a placement", async () => {
    const { renderView, placementId } = await setUpEditing();
    const opened: string[] = [];
    const { container } = renderView((id) => opened.push(id));

    fireEvent.dblClick(interactionCanvasOf(container), {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });
    flush();

    expect(opened).toEqual([placementId]);
  });

  it("reports a click that selects one placement, once (UI-002)", async () => {
    const { renderView, placementId } = await setUpEditing();
    const selected: string[] = [];
    const { container } = renderView(undefined, (id) => selected.push(id));
    const canvas = interactionCanvasOf(container);
    const onClip = {
      clientX: (TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    };

    firePointer(canvas, "pointerdown", onClip);
    firePointer(canvas, "pointerup", onClip);
    // Clicking the clip already selected reports nothing new.
    firePointer(canvas, "pointerdown", onClip);
    firePointer(canvas, "pointerup", onClip);
    flush();

    expect(selected).toEqual([placementId]);
  });

  it("reports nothing for a double-click on empty timeline or on the ruler", async () => {
    const { renderView } = await setUpEditing();
    const opened: string[] = [];
    const { container } = renderView((id) => opened.push(id));
    const canvas = interactionCanvasOf(container);

    // Well past the fixture's single one-bar placement...
    fireEvent.dblClick(canvas, {
      clientX: TICKS_PER_BAR * 8 * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });
    // ...and on the ruler strip, which hosts no rows.
    fireEvent.dblClick(canvas, { clientX: 10, clientY: 2 });
    flush();

    expect(opened).toEqual([]);
  });

  it("has no Open clip button: a double-click is the way in (#493)", async () => {
    const { renderView } = await setUpEditing();
    renderView((): void => undefined);
    expect(screen.queryByRole("button", { name: "Open clip" })).not.toBeInTheDocument();
  });
});

describe("creating a clip (#661)", () => {
  const emptyBarNine = {
    clientX: (TICKS_PER_BAR * 8 + TICKS_PER_BAR / 2) * PIXELS_PER_TICK,
    clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX / 2,
  };

  it("creates a one-bar clip on a double-clicked empty bar, as one undo step", async () => {
    const { renderView, session, transport } = await setUpEditing();
    const clips = session.project.clips.length;
    const { container } = renderView();

    fireEvent.dblClick(interactionCanvasOf(container), emptyBarNine);
    flush();

    const created = session.project.song.placements.at(-1);
    expect(session.project.clips).toHaveLength(clips + 1);
    expect(created?.startTicks).toBe(TICKS_PER_BAR * 8);
    expect(created?.durationTicks).toBe(TICKS_PER_BAR);
    const firstUses = transport.events.filter(
      (event) =>
        event.name === "feature_first_use" &&
        event.params.feature === "arrangement_create_clip",
    );
    expect(firstUses).toHaveLength(1);

    session.undo();
    expect(session.project.clips).toHaveLength(clips);
  });

  it("creates the same clip with analytics off, logging nothing", async () => {
    const { renderView, session, transport } = await setUpEditing(undefined, {
      analyticsEnabled: false,
    });
    const { container } = renderView();

    fireEvent.dblClick(interactionCanvasOf(container), emptyBarNine);
    flush();

    expect(session.project.song.placements.at(-1)?.startTicks).toBe(TICKS_PER_BAR * 8);
    expect(transport.events).toHaveLength(0);
  });
});

describe("arrangement track selection (#228)", () => {
  /** The view with a host holding the selected track, as `EditorView` does. */
  function renderSelectable() {
    const { analytics, transport } = analyticsAllowing();
    const project = createLargeArrangementProject(20);
    const selected: string[] = [];
    const [selectedTrackId, setSelectedTrackId] = createSignal<TrackId | null>(null);
    const result = render(() => (
      <ArrangementView
        project={project}
        analytics={analytics}
        selectedTrackId={selectedTrackId()}
        onSelectTrack={(trackId) => {
          selected.push(trackId);
          setSelectedTrackId(trackId);
        }}
      />
    ));
    return { ...result, project, selected, transport };
  }

  function headerButton(trackName: string): HTMLElement {
    return within(screen.getByLabelText("Tracks")).getByRole("button", {
      name: `Edit ${trackName}`,
    });
  }

  it("selects a track from its header row, and marks the selected one", () => {
    const { project, selected } = renderSelectable();
    const second = project.song.tracks[1];

    expect(headerButton(second.name)).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(headerButton(second.name));

    expect(selected).toEqual([second.id]);
    expect(headerButton(second.name)).toHaveAttribute("aria-pressed", "true");
    expect(headerButton(project.song.tracks[0].name)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("selects the track of the row a pointer lands on in the timeline", () => {
    const { container, project, selected } = renderSelectable();

    // Row 1 (the second track), a bar in and clear of the ruler.
    firePointer(interactionCanvasOf(container), "pointerdown", {
      clientX: TICKS_PER_BAR * PIXELS_PER_TICK,
      clientY: RULER_HEIGHT_PX + ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    });

    expect(selected).toEqual([project.song.tracks[1].id]);
  });

  it("selects the track from the accessible list too, alongside its bar range", () => {
    const { project, selected } = renderSelectable();
    const list = screen.getByLabelText("Arrangement tracks");
    const buttons = list.querySelectorAll<HTMLButtonElement>("button[data-track-select]");

    clickAndFlush(buttons[1]);

    expect(selected).toEqual([project.song.tracks[1].id]);
    // The bar-range selection it already made is unchanged.
    expect(screen.getByTestId("arrangement-selection-live").textContent).toMatch(
      /bars 1 to/,
    );
  });

  it("counts selecting a track as arrangement use, with no event of its own", () => {
    const { project, transport } = renderSelectable();

    clickAndFlush(headerButton(project.song.tracks[1].name));

    expect(featureUses(transport)).toEqual(["arrangement"]);
    expect(transport.events).toHaveLength(1);
  });
});

describe("ArrangementView loop brace (LOOP-018)", () => {
  const rulerY = RULER_HEIGHT_PX / 2;
  const barLine = (bar: number) => (bar - 1) * TICKS_PER_BAR * PIXELS_PER_TICK;

  it("reads the brace out in inclusive bars, since the ruler is only pixels", async () => {
    const { renderView } = await setUpEditing();
    renderView();
    expect(screen.getByTestId("arrangement-loop-live")).toHaveTextContent(
      "Loop over bar 1, looping on",
    );
  });

  it("drags the brace's right edge out a bar, as one entry and one revision", async () => {
    const { session, transport, renderView } = await setUpEditing();
    const { container } = renderView();
    const canvas = interactionCanvasOf(container);
    const revision = session.project.metadata.revision;

    firePointer(canvas, "pointerdown", { clientX: barLine(2), clientY: rulerY });
    firePointer(canvas, "pointermove", { clientX: barLine(2.6), clientY: rulerY });
    firePointer(canvas, "pointermove", { clientX: barLine(3), clientY: rulerY });
    // Every step lands live, so the transport can follow mid-drag.
    expect(session.project.song.loop.endTicks).toBe(2 * TICKS_PER_BAR);
    firePointer(canvas, "pointerup", { clientX: barLine(3), clientY: rulerY });

    expect(session.project.song.loop).toMatchObject({
      startTicks: 0,
      endTicks: 2 * TICKS_PER_BAR,
      enabled: true,
    });
    expect(session.history.entries.length).toBe(1);
    expect(session.project.metadata.revision).toBe(revision + 1);
    expect(transport.named("loop_range_set")).toHaveLength(1);
  });

  it("puts the brace back when Escape cancels the drag, and the release commits nothing (GRV-224)", async () => {
    const { session, transport } = await setUpEditing();
    const holder: { current: PlacementEditingActions | null } = { current: null };
    const { container } = render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        beginGesture={session.beginGesture.bind(session)}
        onEditingActionsReady={(actions) => {
          holder.current = actions;
        }}
      />
    ));
    const canvas = interactionCanvasOf(container);

    firePointer(canvas, "pointerdown", { clientX: barLine(2), clientY: rulerY });
    firePointer(canvas, "pointermove", { clientX: barLine(5), clientY: rulerY });
    expect(session.project.song.loop.endTicks).toBe(4 * TICKS_PER_BAR);
    // The shortcut handler asks the arrangement, so the brace drag must answer.
    expect(holder.current?.isDragging()).toBe(true);

    holder.current?.cancelDrag();

    expect(holder.current?.isDragging()).toBe(false);
    expect(session.project.song.loop.endTicks).toBe(TICKS_PER_BAR);
    firePointer(canvas, "pointermove", { clientX: barLine(6), clientY: rulerY });
    firePointer(canvas, "pointerup", { clientX: barLine(6), clientY: rulerY });
    expect(session.project.song.loop).toMatchObject({
      startTicks: 0,
      endTicks: TICKS_PER_BAR,
    });
    expect(session.history.entries.length).toBe(0);
    expect(transport.named("loop_range_set")).toHaveLength(0);
  });

  it("moves nothing for a press on the ruler away from the brace", async () => {
    const { session, transport, renderView } = await setUpEditing();
    const { container } = renderView();
    const canvas = interactionCanvasOf(container);

    firePointer(canvas, "pointerdown", { clientX: barLine(6.5), clientY: rulerY });
    firePointer(canvas, "pointermove", { clientX: barLine(8), clientY: rulerY });
    firePointer(canvas, "pointerup", { clientX: barLine(8), clientY: rulerY });

    expect(session.project.song.loop).toMatchObject({
      startTicks: 0,
      endTicks: TICKS_PER_BAR,
    });
    expect(session.history.entries.length).toBe(0);
    expect(transport.named("loop_range_set")).toHaveLength(0);
  });

  it("seeks to the nearest grid line for a press clear of the brace, once", async () => {
    const { session, transport, renderView } = await setUpEditing();
    const seek = vi.fn();
    const { container } = renderView(undefined, undefined, seek);
    const canvas = interactionCanvasOf(container);

    firePointer(canvas, "pointerdown", { clientX: barLine(6.6), clientY: rulerY });
    firePointer(canvas, "pointerup", { clientX: barLine(6.6), clientY: rulerY });

    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(6 * TICKS_PER_BAR);
    const uses = transport.events.filter((e) => e.name === "feature_first_use");
    expect(uses).toHaveLength(1);
    expect(uses[0].params).toMatchObject({ feature: "playhead_seek" });

    firePointer(canvas, "pointerdown", { clientX: barLine(3.2), clientY: rulerY });
    firePointer(canvas, "pointerup", { clientX: barLine(3.2), clientY: rulerY });
    expect(seek).toHaveBeenCalledTimes(2);
    expect(transport.events.filter((e) => e.name === "feature_first_use")).toHaveLength(
      1,
    );
    expect(session.history.entries.length).toBe(0);
  });

  it("seeks exactly where the pointer is with Alt held", async () => {
    const { renderView } = await setUpEditing();
    const seek = vi.fn();
    const { container } = renderView(undefined, undefined, seek);
    const canvas = interactionCanvasOf(container);

    firePointer(canvas, "pointerdown", {
      clientX: barLine(6.6),
      clientY: rulerY,
      altKey: true,
    });

    const ticks = seek.mock.calls[0][0] as number;
    expect(ticks).not.toBe(6 * TICKS_PER_BAR);
    expect(Math.abs(ticks - 5.6 * TICKS_PER_BAR)).toBeLessThan(TICKS_PER_BAR / 10);
  });

  it("does not seek for a press that grabs the brace", async () => {
    const { transport, renderView } = await setUpEditing();
    const seek = vi.fn();
    const { container } = renderView(undefined, undefined, seek);
    const canvas = interactionCanvasOf(container);

    firePointer(canvas, "pointerdown", { clientX: barLine(2), clientY: rulerY });
    firePointer(canvas, "pointerup", { clientX: barLine(2), clientY: rulerY });

    expect(seek).not.toHaveBeenCalled();
    expect(
      transport.events.filter(
        (e) => e.name === "feature_first_use" && e.params.feature === "playhead_seek",
      ),
    ).toHaveLength(0);
  });

  it("scrolls to keep a focused brace in view as the keyboard moves it (GRV-226)", async () => {
    const { session } = await setUpEditing();
    const [project, setProject] = createSignal(session.project);
    render(() => (
      <ArrangementView
        project={project()}
        dispatch={session.dispatch.bind(session)}
        onLoopBraceFocusChange={() => {}}
      />
    ));
    const viewport = document.querySelector<HTMLElement>(".arrangement-viewport");
    const brace = screen.getByTestId("arrangement-loop-brace");
    fireEvent.focus(brace);
    flush();
    expect(viewport?.scrollLeft).toBe(0);

    // Bar 13, far past jsdom's 960px view.
    session.dispatch(
      setLoopRange(toTicks(12 * TICKS_PER_BAR), toTicks(13 * TICKS_PER_BAR)),
    );
    setProject(session.project);
    flush();

    const left = parseFloat(brace.style.left);
    const width = parseFloat(brace.style.width);
    expect(viewport?.scrollLeft).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(960);
  });

  it("leaves the view alone when the brace moves without focus (GRV-226)", async () => {
    const { session } = await setUpEditing();
    const [project, setProject] = createSignal(session.project);
    render(() => (
      <ArrangementView
        project={project()}
        dispatch={session.dispatch.bind(session)}
        onLoopBraceFocusChange={() => {}}
      />
    ));
    const viewport = document.querySelector<HTMLElement>(".arrangement-viewport");
    session.dispatch(
      setLoopRange(toTicks(12 * TICKS_PER_BAR), toTicks(13 * TICKS_PER_BAR)),
    );
    setProject(session.project);
    flush();
    expect(viewport?.scrollLeft).toBe(0);
  });

  it("offers no keyboard controls where nothing commits a range", async () => {
    const { renderView } = await setUpEditing();
    renderView();
    expect(screen.queryByRole("group", { name: "Loop brace" })).not.toBeInTheDocument();
  });
});

/**
 * #292: one selection, reached by pointer as CF-009 to CF-011 do, and read back
 * the way a screen-reader user would, through the `aria-live` mirror.
 */
describe("the one arrangement selection (#292)", () => {
  const BAR = TICKS_PER_BAR;
  const rowY = (row: number) => RULER_HEIGHT_PX + row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
  const x = (ticks: number) => ticks * PIXELS_PER_TICK;
  const said = () => screen.getByTestId("arrangement-selection-live").textContent;
  const scale = (container: HTMLElement) =>
    Number(
      container.querySelector(".arrangement-view")?.getAttribute("data-pixels-per-tick"),
    );

  /** CF-010's layout: BD has clips in bars 1 and 3, the next track one across 1-3. */
  async function twoTracks() {
    const built = buildArrangementProject([
      [
        { startTicks: 0, durationTicks: BAR },
        { startTicks: 2 * BAR, durationTicks: BAR },
      ],
      [{ startTicks: 0, durationTicks: 3 * BAR }],
    ]);
    const { session } = await setUpEditing(built.project);
    const actions: { current: PlacementEditingActions | null } = { current: null };
    const view = render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        onEditingActionsReady={(ready) => {
          actions.current = ready;
        }}
      />
    ));
    return { session, actions, ...built, canvas: interactionCanvasOf(view.container) };
  }

  /** Press at one tick and row, drag to another, and release there. */
  function drag(canvas: Element, from: [number, number], to: [number, number]) {
    firePointer(canvas, "pointerdown", { clientX: x(from[0]), clientY: rowY(from[1]) });
    firePointer(canvas, "pointermove", { clientX: x(to[0]), clientY: rowY(to[1]) });
    firePointer(canvas, "pointerup", { clientX: x(to[0]), clientY: rowY(to[1]) });
  }

  it("drags a band across tracks that selects the clips it touches, whole", async () => {
    const { canvas, session, actions, placementIds } = await twoTracks();
    drag(canvas, [1164, 0], [2700, 1]);
    expect(said()).toBe("2 clips selected");
    expect(actions.current?.getSelection()).toEqual([
      placementIds[0][1],
      placementIds[1][0],
    ]);
    // Delete takes both clips whole: the overlapped one is not trimmed.
    expect(actions.current?.deleteSelection()).toBe(true);
    expect(session.project.song.placements.map((p) => p.id)).toEqual([
      placementIds[0][0],
    ]);
  });

  it("starts a band from the empty region below the last track (GRV-191)", async () => {
    const { canvas, actions, placementIds } = await twoTracks();
    // Row 2 does not exist: two tracks, so this press is below them.
    drag(canvas, [2700, 3], [1164, 0]);
    expect(said()).toBe("2 clips selected");
    expect(actions.current?.getSelection()).toEqual([
      placementIds[0][1],
      placementIds[1][0],
    ]);
  });

  it("clears the selection, and sets no point, on a click below the tracks", async () => {
    const { canvas, actions } = await twoTracks();
    drag(canvas, [0.5 * BAR, 0], [0.5 * BAR, 0]);
    expect(actions.current?.getSelection().length).toBe(1);
    drag(canvas, [4.5 * BAR, 3], [4.5 * BAR, 3]);
    expect(actions.current?.getSelection()).toEqual([]);
    expect(said()).toBe("No selection");
  });

  it("selects nothing with a band that touches no clip", async () => {
    const { canvas } = await twoTracks();
    firePointer(canvas, "pointerdown", { clientX: x(0.5 * BAR), clientY: rowY(0) });
    firePointer(canvas, "pointerup", { clientX: 0, clientY: 0 });
    expect(said()).toBe("Selected clip on BD, bar 1");
    drag(canvas, [4.2 * BAR, 0], [4.8 * BAR, 0]);
    expect(said()).toBe("No selection");
  });

  it("keeps a press that barely moves as a click, at the start of its bar", async () => {
    const { canvas } = await twoTracks();
    firePointer(canvas, "pointerdown", { clientX: x(4.5 * BAR), clientY: rowY(0) });
    firePointer(canvas, "pointermove", { clientX: x(4.5 * BAR) + 1, clientY: rowY(0) });
    firePointer(canvas, "pointerup", { clientX: x(4.5 * BAR) + 1, clientY: rowY(0) });
    expect(said()).toBe("Position 5.1.1");
  });

  it("zooms to the whole arrangement from its button, framing bar 1 to the last clip's end", async () => {
    await twoTracks();
    clickAndFlush(screen.getByRole("button", { name: "Zoom to arrangement" }));
    const root = document.querySelector(".arrangement-view") as HTMLElement;
    // The song is three bars long; jsdom's viewport is the shell's initial 960px.
    expect(scale(root.parentElement as HTMLElement)).toBeCloseTo(960 / (3 * BAR));
  });

  it("scrolls a distant playhead into view through its action", async () => {
    const built = buildArrangementProject([[{ startTicks: 0, durationTicks: 40 * BAR }]]);
    const { session } = await setUpEditing(built.project);
    const actions: { current: PlacementEditingActions | null } = { current: null };
    render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        playheadTicks={() => 30 * BAR}
        onEditingActionsReady={(ready) => {
          actions.current = ready;
        }}
      />
    ));
    const viewport = document.querySelector<HTMLElement>(".arrangement-viewport");
    expect(viewport?.scrollLeft).toBe(0);
    actions.current?.scrollToPlayhead();
    flush();
    expect(viewport?.scrollLeft).toBeGreaterThan(0);
  });

  it("moves its native scroll with the playhead when follow turns the page (#964)", async () => {
    const built = buildArrangementProject([[{ startTicks: 0, durationTicks: 40 * BAR }]]);
    const { session } = await setUpEditing(built.project);
    const [ticks, setTicks] = createSignal(0);
    render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        playheadTicks={ticks}
        isPlaying={() => true}
      />
    ));
    flush();
    const viewport = document.querySelector<HTMLElement>(".arrangement-viewport");
    expect(viewport?.scrollLeft).toBe(0);
    // jsdom's viewport is the shell's initial 960px wide: well past it.
    const playheadPx = 960 + 500;
    setTicks(playheadPx / PIXELS_PER_TICK);
    flush();
    // The page turned, so the scrollbar and what is on screen agree, and the
    // playhead sits near the left of the new page rather than off its edge.
    const scrollLeft = viewport?.scrollLeft ?? 0;
    expect(scrollLeft).toBeGreaterThan(0);
    expect(playheadPx - scrollLeft).toBeGreaterThan(0);
    expect(playheadPx - scrollLeft).toBeLessThan(960 / 4);
  });

  it("zooms to a clicked clip from its button, and has nothing to zoom to without one", async () => {
    const { canvas } = await twoTracks();
    const zoom = screen.getByRole("button", { name: "Zoom to selection" });
    expect(zoom).toBeDisabled();
    firePointer(canvas, "pointerdown", { clientX: x(2.5 * BAR), clientY: rowY(0) });
    firePointer(canvas, "pointerup", { clientX: 0, clientY: 0 });
    expect(said()).toBe("Selected clip on BD, bar 3");
    clickAndFlush(zoom);
    // jsdom lays nothing out, so the viewport is the shell's initial 960px.
    const root = document.querySelector(".arrangement-view") as HTMLElement;
    expect(scale(root.parentElement as HTMLElement)).toBeCloseTo(960 / BAR);
  });
});

describe("Cmd/Ctrl-click and Shift-click on clips (#405)", () => {
  const BAR = TICKS_PER_BAR;
  const said = () => screen.getByTestId("arrangement-selection-live").textContent;

  /** CF-015's layout: BD and the next track each have clips in bars 1, 2 and 3. */
  async function cf015() {
    const row = [0, 1, 2].map((bar) => ({ startTicks: bar * BAR, durationTicks: BAR }));
    const built = buildArrangementProject([row, row]);
    const { session } = await setUpEditing(built.project);
    const actions: { current: PlacementEditingActions | null } = { current: null };
    const view = render(() => (
      <ArrangementView
        project={session.project}
        dispatch={session.dispatch.bind(session)}
        onEditingActionsReady={(ready) => {
          actions.current = ready;
        }}
      />
    ));
    const canvas = interactionCanvasOf(view.container);
    /** Click the middle of `bar` (1-based) on `row`. jsdom's navigator is off
     * macOS, so Ctrl is the toggling modifier here. */
    const click = (row: number, bar: number, held: "ctrl" | "shift" | null = null) => {
      const at = {
        clientX: (bar - 0.5) * BAR * PIXELS_PER_TICK,
        clientY: RULER_HEIGHT_PX + row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
        ctrlKey: held === "ctrl",
        shiftKey: held === "shift",
      };
      firePointer(canvas, "pointerdown", at);
      firePointer(canvas, "pointerup", at);
    };
    return { session, actions, click, ...built };
  }

  it("walks CF-015: toggle in, toggle out, extend to a box, and Delete takes it", async () => {
    const { session, actions, click, placementIds } = await cf015();
    click(0, 1);
    expect(said()).toBe("Selected clip on BD, bar 1");
    click(0, 3, "ctrl");
    // Two, not three: the clip between them stays out.
    expect(said()).toBe("2 clips selected");
    click(0, 1, "ctrl");
    expect(said()).toBe("Selected clip on BD, bar 3");
    click(1, 2, "shift");
    expect(said()).toBe("4 clips selected");
    expect(actions.current?.deleteSelection()).toBe(true);
    expect(session.project.song.placements.map((p) => p.id)).toEqual([
      placementIds[0][0],
      placementIds[1][0],
    ]);
  });

  it("still replaces the selection on a plain click, and moves nothing on a modifier-click", async () => {
    const { session, click } = await cf015();
    const before = session.project.song.placements;
    click(0, 1);
    click(0, 2, "ctrl");
    click(1, 1, "shift");
    expect(said()).toBe("4 clips selected");
    click(1, 3);
    expect(said()).toBe("Selected clip on Track 2, bar 3");
    expect(session.project.song.placements).toEqual(before);
  });
});

describe("dragging a track header to reorder it (TRK-02)", () => {
  const ROW = 40;

  function renderReorderable() {
    const history = new CommandHistory(
      createReferenceProject({ trackCount: 3, placementCount: 3 }),
    );
    const [project, setProject] = createSignal(history.project);
    const { analytics, transport } = analyticsAllowing();
    const selected: TrackId[] = [];
    stubTrackDragLayout({
      axis: "y",
      zoneSelector: ".arrangement-headers",
      size: ROW,
      zoneLength: ROW * 10,
      order: () => orderedTrackIds(history.project),
    });
    render(() => (
      <ArrangementView
        project={project()}
        analytics={analytics}
        dispatch={(commands) => {
          const result = history.execute(commands);
          setProject(history.project);
          return result;
        }}
        onSelectTrack={(trackId) => selected.push(trackId)}
      />
    ));
    const names = () =>
      [...history.project.song.tracks]
        .sort((a, b) => a.order - b.order)
        .map((track) => track.name);
    const header = (name: string) =>
      within(screen.getByLabelText("Tracks")).getByRole("button", {
        name: `Edit ${name}`,
      });
    return { history, transport, selected, names, header };
  }

  it("moves the track to where it is dropped, previewing it there first", () => {
    const { history, transport, names, header } = renderReorderable();
    const [a, b, c] = names();

    dragTrackHandle(header(c), { x: 50, y: 2 }, () => {
      // Drawn in the top row already, translucent; nothing is committed yet.
      const preview = screen.getByTestId("track-drop-indicator");
      expect(preview).toContainElement(header(c));
      expect(preview).toHaveClass("track-dragging");
      expect(preview.style.top).toBe("0px");
      expect(header(a).closest("li")?.style.top).toBe(preview.style.height);
      expect(names()).toEqual([a, b, c]);
      expect(history.entries).toHaveLength(0);
    });

    expect(screen.queryByTestId("track-drop-indicator")).toBeNull();
    expect(names()).toEqual([c, a, b]);
    expect(history.entries).toHaveLength(1);
    expect(transport.named("track_reordered").map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "arrangement", method: "drag" }),
    ]);
  });

  // #844: the effects that redraw on a drag edge or a project change re-read
  // the projection from their apply halves, which Solid's dev build reported
  // as STRICT_READ_UNTRACKED on every edit and every drag.
  it("drags and reorders without a STRICT_READ_UNTRACKED warning (#844)", () => {
    const warn = vi.spyOn(console, "warn");
    const { header, names } = renderReorderable();
    const [, , c] = names();
    dragTrackHandle(header(c), { x: 50, y: 2 }, () => {});
    flush();
    expect(names()[0]).toBe(c);
    const strictReads = warn.mock.calls.filter(([message]) =>
      String(message).includes("STRICT_READ_UNTRACKED"),
    );
    expect(strictReads).toHaveLength(0);
  });

  it("does not also select the track: the click a drag ends in is swallowed", async () => {
    const { selected, names, header } = renderReorderable();
    const [a, , c] = names();

    dragTrackHandle(header(c), { x: 50, y: 2 });
    clickAndFlush(header(c));
    expect(selected).toEqual([]);

    // Only that one click: the next is an ordinary selection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    clickAndFlush(header(a));
    expect(selected).toHaveLength(1);
  });

  it("changes nothing when released outside the column, or where it started", () => {
    const { history, transport, names, header } = renderReorderable();
    const before = names();

    dragTrackHandle(header(before[1]), { x: 500, y: 2 }, () => {
      expect(screen.queryByTestId("track-drop-indicator")).toBeNull();
    });
    dragTrackHandle(header(before[1]), { x: 50, y: ROW + 5 });

    expect(names()).toEqual(before);
    expect(history.entries).toHaveLength(0);
    expect(transport.named("track_reordered")).toHaveLength(0);
  });
});

describe("ArrangementView track header faders (#447)", () => {
  it("keeps a header's fader through a drag, so the drag keeps moving it", () => {
    const history = new CommandHistory(createSliceFixtureProject());
    const [project, setProject] = createSignal(history.project);
    const dispatch = (commands: Parameters<CommandHistory["execute"]>[0]) => {
      const result = history.execute(commands);
      setProject(history.project);
      return result;
    };
    render(() => (
      <ArrangementView
        project={project()}
        analytics={analyticsAllowing().analytics}
        dispatch={dispatch}
        beginGesture={(options) => {
          const gesture = history.beginGesture(options);
          return {
            get active() {
              return gesture.active;
            },
            apply(commands) {
              const result = gesture.apply(commands);
              setProject(history.project);
              return result;
            },
            commit(summary) {
              const entry = gesture.commit(summary);
              setProject(history.project);
              return entry;
            },
            cancel: () => gesture.cancel(),
          };
        }}
      />
    ));
    const track = history.project.song.tracks[0];
    const fader = () => screen.getByRole("slider", { name: `Volume for ${track.name}` });
    const grabbed = fader();

    // Each step of a drag is an edit; the row must not be rebuilt under it.
    for (const value of ["0.6", "0.5", "0.4"]) {
      fireEvent.input(grabbed, { target: { value } });
      flush();
      expect(fader()).toBe(grabbed);
    }
    fireEvent.change(grabbed, { target: { value: "0.4" } });
    flush();

    expect(history.project.song.tracks[0].mixer.volume).toBeLessThan(track.mixer.volume);
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(history.project.song.tracks[0].mixer.volume).toBe(track.mixer.volume);
  });
});

describe("vertical scroll range (#959)", () => {
  it("scrolls the rows as far as the spacer does, so the last lane clears the dock", () => {
    // The issue's 1280x800 case: nine tracks in a 745px-tall scroller.
    const viewportHeight = 745;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const height = this.classList.contains("arrangement-viewport") ? viewportHeight : 0;
      return new DOMRect(0, 0, 1080, height);
    });
    const { project } = buildArrangementProject(Array.from({ length: 9 }, () => []));
    const { container } = render(() => (
      <ArrangementView project={project} belowTracks={<span>Add track</span>} />
    ));
    flush();

    const scroller = container.querySelector(".arrangement-viewport") as HTMLElement;
    const spacer = container.querySelector(".arrangement-spacer") as HTMLElement;
    const headers = container.querySelector(".arrangement-headers-inner") as HTMLElement;
    const belowTracks = container.querySelector(
      ".arrangement-below-tracks",
    ) as HTMLElement;

    // Scroll the native scroller to its bottom: the spacer less the viewport.
    const nativeMax = Number.parseFloat(spacer.style.height) - viewportHeight;
    expect(nativeMax).toBeGreaterThan(0);
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: nativeMax,
    });
    fireEvent.scroll(scroller);
    flush();

    // The rows and the add-track unit move with it, all the way.
    expect(headers.style.transform).toBe(`translateY(${-nativeMax}px)`);
    expect(belowTracks.style.transform).toBe(`translateY(${-nativeMax}px)`);
  });
});

describe("the clip list (#76)", () => {
  const BAR = TICKS_PER_BAR;

  async function withClipList() {
    const built = buildArrangementProject([
      [
        { startTicks: 0, durationTicks: BAR },
        { startTicks: 2 * BAR, durationTicks: BAR },
      ],
      [{ startTicks: 0, durationTicks: 3 * BAR }],
    ]);
    const { session, transport } = await setUpEditing(built.project);
    const actions: { current: PlacementEditingActions | null } = { current: null };
    const focusChanges: boolean[] = [];
    const analytics = new Analytics({
      transport,
      consent: (() => {
        const consent = new ConsentStore(memoryStorage());
        consent.optIn();
        return consent;
      })(),
      storage: memoryStorage(),
    });
    const { unmount } = render(() => (
      <ArrangementView
        project={session.project}
        analytics={analytics}
        dispatch={session.dispatch.bind(session)}
        onEditingActionsReady={(ready) => {
          actions.current = ready;
        }}
        onClipListFocusChange={(focused) => focusChanges.push(focused)}
      />
    ));
    const list = screen.getByRole("listbox", { name: "Clips" });
    return { ...built, session, transport, actions, focusChanges, list, unmount };
  }

  const announcement = () =>
    screen.getByTestId("arrangement-selection-live").textContent ?? "";

  it("lists every clip in reading order, as one tab stop", async () => {
    const { list } = await withClipList();
    expect(list).toHaveAttribute("tabindex", "0");
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringMatching(/on BD, bar 1$/),
      expect.stringMatching(/on BD, bar 3$/),
      expect.stringMatching(/bars 1 to 3$/),
    ]);
    expect(options.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("reports focus, so the editor can turn its arrows on", async () => {
    const { list, focusChanges } = await withClipList();
    fireEvent.focus(list);
    fireEvent.blur(list);
    expect(focusChanges).toEqual([true, false]);
  });

  it("says it has lost focus when it goes with focus in it", async () => {
    const { list, focusChanges, unmount } = await withClipList();
    fireEvent.focus(list);
    // No blur: Firefox fires none when a focused element is removed.
    unmount();
    expect(focusChanges).toEqual([true, false]);
  });

  it("adds the next clip to the selection with Shift, and carries on from it", async () => {
    const { list, actions, placementIds } = await withClipList();
    actions.current?.stepClip(1);
    actions.current?.extendClip(1);
    flush();
    expect(actions.current?.getSelection()).toEqual([
      placementIds[0][0],
      placementIds[0][1],
    ]);
    const selected = within(list)
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-selected"));
    expect(selected).toEqual(["true", "true", "false"]);
    const active = list.getAttribute("aria-activedescendant");
    expect(active).toBe(within(list).getAllByRole("option")[1].id);

    actions.current?.extendClip(1);
    flush();
    expect(actions.current?.getSelection()).toHaveLength(3);
  });

  it("moves the selected clips' ends a bar, the edge drag's keyboard twin", async () => {
    const { actions, placementIds, session } = await withClipList();
    const duration = (id: PlacementId) =>
      session.project.song.placements.find((p) => p.id === id)?.durationTicks;
    actions.current?.select(placementIds[1][0]);
    actions.current?.resizeSelection("end", -1);
    flush();
    expect(duration(placementIds[1][0])).toBe(2 * BAR);

    // Lengthening the first clip over the second overwrites it, as a drop does.
    actions.current?.select(placementIds[0][0]);
    actions.current?.resizeSelection("end", 1);
    actions.current?.resizeSelection("end", 1);
    flush();
    expect(duration(placementIds[0][0])).toBe(3 * BAR);
    expect(duration(placementIds[0][1])).toBeUndefined();
    session.undo();
    expect(duration(placementIds[0][0])).toBe(2 * BAR);
  });

  it("steps the selection through the clips as a click on each would", async () => {
    const { list, actions, placementIds } = await withClipList();
    actions.current?.stepClip(1);
    flush();
    expect(actions.current?.getSelection()).toEqual([placementIds[0][0]]);
    expect(announcement()).toBe("Selected clip on BD, bar 1");
    const active = list.getAttribute("aria-activedescendant");
    expect(active && document.getElementById(active)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    actions.current?.stepClip(1);
    actions.current?.stepClip(1);
    flush();
    expect(actions.current?.getSelection()).toEqual([placementIds[1][0]]);
    // At the end it stays put.
    actions.current?.stepClip(1);
    flush();
    expect(actions.current?.getSelection()).toEqual([placementIds[1][0]]);

    actions.current?.stepClip(-1);
    flush();
    expect(announcement()).toBe("Selected clip on BD, bar 3");
  });

  it("starts from the clip a click selected", async () => {
    const { actions, placementIds } = await withClipList();
    actions.current?.select(placementIds[0][1]);
    actions.current?.stepClip(-1);
    flush();
    expect(actions.current?.getSelection()).toEqual([placementIds[0][0]]);
  });

  it("logs its feature_first_use once, however many steps", async () => {
    const { actions, transport } = await withClipList();
    actions.current?.stepClip(1);
    actions.current?.stepClip(1);
    const firstUses = transport.events.filter(
      (event) =>
        event.name === "feature_first_use" &&
        event.params.feature === "arrangement_clip_list",
    );
    expect(firstUses).toHaveLength(1);
  });

  it("is not there in an arrangement with no clips", () => {
    const { project } = buildArrangementProject([
      [{ startTicks: 0, durationTicks: BAR }],
    ]);
    render(() => (
      <ArrangementView
        project={{ ...project, song: { ...project.song, placements: [] } }}
      />
    ));
    expect(screen.queryByRole("listbox", { name: "Clips" })).toBeNull();
  });
});
