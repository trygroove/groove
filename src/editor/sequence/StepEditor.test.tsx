import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import type { Clip, Project } from "../../domain/entities";
import {
  createDenseStepFixtureProject,
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import type { EventId, PadId } from "../../domain/ids";
import { TICKS_PER_BAR } from "../../domain/time";
import { clickAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import StepEditor from "./StepEditor";

afterEach(() => cleanup());

/**
 * Renders `StepEditor` over a real `CommandHistory` for the given project's
 * first clip, so paint/erase strokes flow through the same command/gesture
 * kernel the editor uses in production. The rendered clip is reactive: the
 * history's change notifications update it, so the grid reflects each edit.
 */
function renderEditor(project: Project) {
  const clipId = project.clips[0].id;
  const track = project.song.tracks.find(
    (candidate) =>
      candidate.instrument !== null && project.clips[0].trackId === candidate.id,
  );
  const history = new CommandHistory(project);
  const [clip, setClip] = createSignal<Clip>(project.clips[0]);
  const [live, setLive] = createSignal<Project>(project);
  const [selectedIds, setSelectedIds] = createSignal<readonly EventId[]>([]);
  history.subscribe((snapshot) => {
    setLive(snapshot.project);
    const next = snapshot.project.clips.find((candidate) => candidate.id === clipId);
    if (next) setClip(next);
  });

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");

  const [playbackStep, setPlaybackStep] = createSignal<number | null>(null);

  render(() => (
    <StepEditor
      clip={clip()}
      project={live()}
      instrument={track?.instrument ?? null}
      dispatch={(commands) => history.execute(commands as never)}
      beginGesture={(options) => history.beginGesture(options)}
      playbackStep={playbackStep}
      selectedIds={selectedIds}
      setSelectedIds={setSelectedIds}
      analytics={analytics}
    />
  ));

  return {
    history,
    clip,
    live,
    transport,
    selectedIds,
    setSelectedIds,
    setPlaybackStep,
  };
}

function cell(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

/** The velocity of the note starting on the given tick, as the clip holds it. */
function velocityAt(clip: Clip, startTicks: number): number | undefined {
  const content = clip.content;
  if (content.kind !== "notes") throw new Error("expected a note clip");
  return content.events.find((event) => event.startTicks === startTicks)?.velocity;
}

/** A complete paint/erase stroke: down on the first cell, up to commit. */
function stroke(name: string): void {
  const target = cell(name);
  fireEvent.pointerDown(target, { button: 0 });
  flush();
  fireEvent.pointerUp(target);
  flush();
}

/** A cell's centre, in the lanes' pixels: 40 px steps and 30 px rows at 100%. */
function centre(row: number, step: number): { x: number; y: number } {
  return { x: (step - 1) * 40 + 20, y: row * 30 + 15 };
}

/**
 * Fires a pointer event with a position, as the piano roll's tests do: jsdom
 * has no `PointerEvent`, and `fireEvent.pointerMove` would drop the position.
 */
function firePointer(
  target: Element,
  type: string,
  at: { x: number; y: number; shiftKey?: boolean },
): void {
  fireEvent(
    target,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: at.x,
      clientY: at.y,
      shiftKey: at.shiftKey ?? false,
    }),
  );
  flush();
}

const editorRegion = () => screen.getByRole("region", { name: "Step editor" });

/**
 * A press on one cell that moves to another before letting go. jsdom lays
 * nothing out, so the lanes' corner is at 0,0 and a client position is a
 * position in the lanes. Moves and the release land on the editor region,
 * where the handlers live.
 */
function drag(
  from: { name: string; row: number; step: number },
  to: { row: number; step: number },
  modifiers: { shiftKey?: boolean } = {},
): void {
  firePointer(cell(from.name), "pointerdown", {
    ...centre(from.row, from.step),
    ...modifiers,
  });
  firePointer(editorRegion(), "pointermove", centre(to.row, to.step));
  firePointer(editorRegion(), "pointerup", centre(to.row, to.step));
}

function clipEditedEvents(transport: ReturnType<typeof createRecordingTransport>) {
  return transport.events.filter((event) => event.name === "clip_edited");
}

describe("StepEditor", () => {
  it("renders one pitched lane for a sampler clip, marking saved steps active", () => {
    renderEditor(createSliceFixtureProject());
    // The single lane is named "Notes"; the slice clip has steps 1, 5, 9, 13 on.
    expect(cell("Notes, step 1, on")).toBeInTheDocument();
    expect(cell("Notes, step 2, off")).toBeInTheDocument();
    expect(cell("Notes, step 5, on")).toBeInTheDocument();
    // 1 bar × 16 steps.
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(16);
  });

  it("renders one named lane per pad for a drum-machine clip", () => {
    renderEditor(createDrumMachineFixtureProject());
    expect(screen.getByLabelText("Lane BD")).toBeInTheDocument();
    expect(screen.getByLabelText("Lane CP")).toBeInTheDocument();
    // The drum fixture's beat: BD on 1/5/9/13, CP on 5/13.
    expect(cell("BD, step 1, on")).toBeInTheDocument();
    expect(cell("CP, step 5, on")).toBeInTheDocument();
    expect(cell("CP, step 1, off")).toBeInTheDocument();
  });

  it("paints an empty step with a single note.add gesture and one history entry", () => {
    const { history } = renderEditor(createSliceFixtureProject());
    expect(history.canUndo).toBe(false);

    stroke("Notes, step 2, off");

    expect(cell("Notes, step 2, on")).toBeInTheDocument();
    expect(history.canUndo).toBe(true);
    // One entry for the whole stroke.
    expect(history.entries).toHaveLength(1);
  });

  it("erases an occupied step", () => {
    const { history } = renderEditor(createSliceFixtureProject());
    stroke("Notes, step 1, on");
    expect(cell("Notes, step 1, off")).toBeInTheDocument();
    expect(history.entries).toHaveLength(1);
  });

  it("lassoes every note a drag touches across rows, and edits nothing (#643)", () => {
    const { history, selectedIds, clip } = renderEditor(
      createDrumMachineFixtureProject(),
    );
    const before = clip();

    // From BD step 4 to CP step 6: BD and CP both have a note on step 5.
    drag({ name: "BD, step 4, off", row: 0, step: 4 }, { row: 1, step: 6 });

    const content = clip().content;
    if (content.kind !== "notes") throw new Error("expected a note clip");
    const onStep5 = content.events
      .filter((event) => event.startTicks === 4 * 48)
      .map((event) => event.id);
    expect([...selectedIds()].sort()).toEqual([...onStep5].sort());
    expect(onStep5).toHaveLength(2);
    // A lasso only selects: the step it started on stays off, nothing is logged.
    expect(cell("BD, step 4, off")).toBeInTheDocument();
    expect(clip()).toBe(before);
    expect(history.entries).toHaveLength(0);
  });

  it("draws the lasso while it is dragged, and not after", () => {
    renderEditor(createDrumMachineFixtureProject());
    firePointer(cell("BD, step 2, off"), "pointerdown", centre(0, 2));
    firePointer(editorRegion(), "pointermove", centre(1, 6));
    expect(editorRegion().querySelector(".step-lasso")).not.toBeNull();
    firePointer(editorRegion(), "pointerup", centre(1, 6));
    expect(editorRegion().querySelector(".step-lasso")).toBeNull();
  });

  it("starts a lasso on the empty ground under the last row (#643)", () => {
    const { history, selectedIds, clip } = renderEditor(
      createDrumMachineFixtureProject(),
    );
    const ground = editorRegion().querySelector(".step-lanes");
    if (!ground) throw new Error("expected the lanes");
    const rows = screen.getAllByRole("group", { name: /^Lane / }).length;
    const before = clip();

    // From the ground below the last row, up and across step 5 in every row.
    firePointer(ground, "pointerdown", centre(rows + 1, 5));
    firePointer(editorRegion(), "pointermove", centre(0, 5));
    expect(editorRegion().querySelector(".step-lasso")).not.toBeNull();
    firePointer(editorRegion(), "pointerup", centre(0, 5));

    const content = clip().content;
    if (content.kind !== "notes") throw new Error("expected a note clip");
    const onStep5 = content.events
      .filter((event) => event.startTicks === 4 * 48)
      .map((event) => event.id);
    expect(onStep5.length).toBeGreaterThan(0);
    expect([...selectedIds()].sort()).toEqual([...onStep5].sort());
    expect(clip()).toBe(before);
    expect(history.entries).toHaveLength(0);
  });

  it("clears the selection on a click on the empty ground, editing nothing", () => {
    const { history, selectedIds, setSelectedIds, clip } = renderEditor(
      createDrumMachineFixtureProject(),
    );
    const content = clip().content;
    if (content.kind !== "notes") throw new Error("expected a note clip");
    setSelectedIds([content.events[0].id]);
    flush();
    const ground = editorRegion().querySelector(".step-lanes");
    if (!ground) throw new Error("expected the lanes");
    const rows = screen.getAllByRole("group", { name: /^Lane / }).length;

    firePointer(ground, "pointerdown", centre(rows + 1, 4));
    firePointer(editorRegion(), "pointerup", centre(rows + 1, 4));

    expect(selectedIds()).toEqual([]);
    expect(history.entries).toHaveLength(0);
  });

  it("adds a Shift-lasso to the selection, as the piano roll does", () => {
    const { selectedIds, setSelectedIds, clip } = renderEditor(
      createDrumMachineFixtureProject(),
    );
    const content = clip().content;
    if (content.kind !== "notes") throw new Error("expected a note clip");
    const first = content.events.find((event) => event.startTicks === 0);
    if (!first) throw new Error("expected a note on step 1");
    setSelectedIds([first.id]);
    flush();

    drag(
      { name: "BD, step 12, off", row: 0, step: 12 },
      { row: 0, step: 14 },
      { shiftKey: true },
    );

    // The step-1 note stays selected, and the step-13 note joins it.
    expect(selectedIds()).toHaveLength(2);
    expect(selectedIds()).toContain(first.id);
  });

  it("treats a press that moves under 4 px as a click, which toggles the step", () => {
    const { history } = renderEditor(createSliceFixtureProject());
    const { x, y } = centre(0, 2);
    firePointer(cell("Notes, step 2, off"), "pointerdown", { x, y });
    firePointer(editorRegion(), "pointermove", { x: x + 2, y: y + 1 });
    firePointer(editorRegion(), "pointerup", { x: x + 2, y: y + 1 });
    expect(cell("Notes, step 2, on")).toBeInTheDocument();
    expect(history.entries).toHaveLength(1);
  });

  it("toggles a focused step from the keyboard, as one history entry (GRV-214)", () => {
    const { history } = renderEditor(createSliceFixtureProject());
    // Enter and Space on a focused button arrive as a click with no pointer
    // press and a detail of 0.
    fireEvent.click(cell("Notes, step 2, off"), { detail: 0 });
    flush();
    expect(cell("Notes, step 2, on")).toBeInTheDocument();
    expect(history.entries).toHaveLength(1);

    fireEvent.click(cell("Notes, step 2, on"), { detail: 0 });
    flush();
    expect(cell("Notes, step 2, off")).toBeInTheDocument();
    expect(history.entries).toHaveLength(2);
  });

  it("does not toggle twice for a mouse click, whose click follows its press", () => {
    const { history } = renderEditor(createSliceFixtureProject());
    stroke("Notes, step 2, off");
    fireEvent.click(cell("Notes, step 2, on"), { detail: 1 });
    flush();
    expect(cell("Notes, step 2, on")).toBeInTheDocument();
    expect(history.entries).toHaveLength(1);
  });

  it("emits clip_edited once for a click, bucketed by changed steps", () => {
    const { transport } = renderEditor(createSliceFixtureProject());

    stroke("Notes, step 2, off");

    const edited = clipEditedEvents(transport);
    expect(edited).toHaveLength(1);
    expect(edited[0].params.editor).toBe("step");
    expect(edited[0].params.event_count_bucket).toBe("1_4");
  });

  it("emits clip_edited per stroke, not per step, across two strokes", () => {
    const { transport } = renderEditor(createSliceFixtureProject());
    stroke("Notes, step 2, off");
    stroke("Notes, step 3, off");
    expect(clipEditedEvents(transport)).toHaveLength(2);
  });

  it("emits one clip_edited for an erase stroke", () => {
    const { transport, history } = renderEditor(createSliceFixtureProject());
    stroke("Notes, step 1, on"); // erase a saved note
    const edited = clipEditedEvents(transport);
    expect(edited).toHaveLength(1);
    expect(edited[0].params.editor).toBe("step");
    expect(history.entries).toHaveLength(1);
  });

  it("logs step_editor feature_first_use once, through the catalog, across two strokes", () => {
    const { transport } = renderEditor(createSliceFixtureProject());
    stroke("Notes, step 2, off");
    stroke("Notes, step 3, off");
    const firstUse = transport.events.filter(
      (event) => event.name === "feature_first_use",
    );
    expect(firstUse).toHaveLength(1);
    expect(firstUse[0].params.feature).toBe("step_editor");
  });

  it("still paints when analytics is disabled, emitting no events", () => {
    const consent = new ConsentStore(memoryStorage());
    consent.set({ productAnalytics: false });
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent,
      storage: memoryStorage(),
    });
    const project = createSliceFixtureProject();
    const history = new CommandHistory(project);
    const [clip, setClip] = createSignal<Clip>(project.clips[0]);
    history.subscribe((snapshot) => {
      const next = snapshot.project.clips[0];
      if (next) setClip(next);
    });
    render(() => (
      <StepEditor
        clip={clip()}
        project={project}
        instrument={project.song.tracks[0].instrument}
        dispatch={(commands) => history.execute(commands as never)}
        beginGesture={(options) => history.beginGesture(options)}
        analytics={analytics}
      />
    ));

    stroke("Notes, step 2, off");

    // The edit still lands…
    expect(cell("Notes, step 2, on")).toBeInTheDocument();
    expect(history.canUndo).toBe(true);
    // …but with consent denied, nothing was sent.
    expect(transport.events).toHaveLength(0);
  });

  it("shift-click selects an existing note without erasing it", () => {
    const { selectedIds, history } = renderEditor(createSliceFixtureProject());
    const target = cell("Notes, step 1, on");
    // jsdom has no PointerEvent, so build a plain event carrying shiftKey.
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.assign(down, { button: 0, shiftKey: true });
    target.dispatchEvent(down);
    flush();
    fireEvent.pointerUp(target);
    flush();

    // Still on (not erased), and now selected.
    expect(cell("Notes, step 1, on")).toBeInTheDocument();
    expect(selectedIds()).toHaveLength(1);
    expect(history.canUndo).toBe(false);
  });

  it("resizes the clip to a whole number of bars through clip.update", () => {
    const { history, clip } = renderEditor(createSliceFixtureProject());
    expect(clip().lengthTicks).toBe(TICKS_PER_BAR);

    const select = screen.getByRole("combobox", { name: "Bars" });
    fireEvent.change(select, { target: { value: "4" } });
    flush();

    expect(clip().lengthTicks).toBe(TICKS_PER_BAR * 4);
    // The grid now shows 4 bars × 16 steps on the single lane.
    expect(cell("Notes, step 64, off")).toBeInTheDocument();
    expect(history.entries.at(-1)?.commands[0].type).toBe("clip.update");
  });

  // #963: the arrangement placement stayed one bar, so bars 2-32 never played
  // or exported. A placement that showed the whole clip grows with it.
  it("grows the placement that showed the whole clip, as one undo step", () => {
    const { history, live } = renderEditor(createSliceFixtureProject());
    const placement = () => live().song.placements[0];
    expect(placement().durationTicks).toBe(TICKS_PER_BAR);

    fireEvent.change(screen.getByRole("combobox", { name: "Bars" }), {
      target: { value: "32" },
    });
    flush();

    expect(placement().durationTicks).toBe(TICKS_PER_BAR * 32);
    expect(history.entries).toHaveLength(1);

    history.undo();
    flush();
    expect(live().clips[0].lengthTicks).toBe(TICKS_PER_BAR);
    expect(placement().durationTicks).toBe(TICKS_PER_BAR);
  });

  it("offers the musical bar lengths up to 32 rather than every integer", () => {
    renderEditor(createSliceFixtureProject());
    const select = screen.getByRole("combobox", { name: "Bars" });
    const options = Array.from(select.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["1", "2", "4", "8", "16", "32"]);
  });

  it("marks the current playback step while playing", () => {
    const { setPlaybackStep } = renderEditor(createSliceFixtureProject());
    setPlaybackStep(3);
    flush();
    // The playing class lands on the cell at step 4 (index 3).
    const playingCell = cell("Notes, step 4, off");
    expect(playingCell.className).toContain("playing");
  });

  it("renders the dense 8-bar fixture with every lane and 128 steps per lane", () => {
    renderEditor(createDenseStepFixtureProject());
    expect(screen.getByLabelText("Lane BD")).toBeInTheDocument();
    expect(screen.getByLabelText("Lane SD")).toBeInTheDocument();
    expect(screen.getByLabelText("Lane HH")).toBeInTheDocument();
    // 8 bars × 16 = 128 steps; the last step exists on each lane.
    expect(cell("BD, step 128, off")).toBeInTheDocument();
    expect(cell("HH, step 127, on")).toBeInTheDocument();
  });

  it("paints and erases without leaving the browser default text selection on", () => {
    renderEditor(createSliceFixtureProject());
    const target = cell("Notes, step 2, off");
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    // The handler prevents default so a drag never starts a text selection.
    const prevented = !target.dispatchEvent(event);
    expect(prevented).toBe(true);
  });
});

describe("StepEditor rows (#643)", () => {
  /** The drum fixture's grid, with the host owning the selected row. */
  function renderRows(initial: PadId | null = null) {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks[0];
    if (track.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [kick, clap] = track.instrument.pads;
    const history = new CommandHistory(project);
    const [clip, setClip] = createSignal<Clip>(project.clips[0]);
    history.subscribe((snapshot) => setClip(snapshot.project.clips[0]));
    const [selectedPad, setSelectedPad] = createSignal<PadId | null>(initial);
    const onSelectPad = vi.fn((padId: PadId) => setSelectedPad(padId));
    const auditionPad = vi.fn();
    const onTogglePlay = vi.fn();
    const onToggleSolo = vi.fn();
    render(() => (
      <StepEditor
        clip={clip()}
        project={project}
        instrument={track.instrument}
        dispatch={(commands) => history.execute(commands as never)}
        beginGesture={(options) => history.beginGesture(options)}
        selectedPadId={selectedPad()}
        onSelectPad={onSelectPad}
        auditionPad={auditionPad}
        onTogglePlay={onTogglePlay}
        onToggleSolo={onToggleSolo}
      />
    ));
    return {
      history,
      clip,
      kick,
      clap,
      setSelectedPad,
      onSelectPad,
      auditionPad,
      onTogglePlay,
      onToggleSolo,
    };
  }

  const rows = () => within(screen.getByRole("group", { name: "Rows" }));
  const rowButton = (name: string) =>
    rows().getByRole("button", { name: new RegExp(`^${name}$`) });

  it("names one row button per pad, the first selected until one is picked", () => {
    renderRows();
    expect(
      rows()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["BD", "CP"]);
    expect(rowButton("BD")).toHaveAttribute("aria-pressed", "true");
    expect(rowButton("CP")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Lane BD")).toHaveAttribute("aria-current", "true");
  });

  it("picks a row by its name, plays its pad and shares it as the selected pad", () => {
    const { clap, onSelectPad, auditionPad } = renderRows();
    clickAndFlush(rowButton("CP"));
    expect(rowButton("CP")).toHaveAttribute("aria-pressed", "true");
    expect(rowButton("BD")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Lane CP")).toHaveAttribute("aria-current", "true");
    expect(onSelectPad).toHaveBeenCalledExactlyOnceWith(clap.id);
    expect(auditionPad).toHaveBeenCalledExactlyOnceWith(clap.id);
  });

  it("follows a pad selected elsewhere, in the drum machine panel", () => {
    const { clap, setSelectedPad } = renderRows();
    setSelectedPad(clap.id);
    flush();
    expect(rowButton("CP")).toHaveAttribute("aria-pressed", "true");
  });

  it("never moves the row when a cell is painted, though it plays the pad", () => {
    const { clap, onSelectPad, auditionPad } = renderRows();
    stroke("CP, step 2, off");
    expect(cell("CP, step 2, on")).toBeInTheDocument();
    expect(rowButton("BD")).toHaveAttribute("aria-pressed", "true");
    expect(onSelectPad).not.toHaveBeenCalled();
    expect(auditionPad).toHaveBeenCalledExactlyOnceWith(clap.id);
  });

  it("plays nothing while Preview sound is off", () => {
    const { auditionPad } = renderRows();
    const toggle = screen.getByRole("button", { name: "Preview sound" });
    clickAndFlush(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(rowButton("CP"));
    stroke("CP, step 2, off");
    expect(auditionPad).not.toHaveBeenCalled();
  });

  it("has the piano roll's toolbar: Bars, Select all, Delete, zoom and Play", () => {
    const { history, clip, onTogglePlay } = renderRows();
    expect(screen.getByRole("combobox", { name: "Bars" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Velocity" })).toBeNull();
    // The ruler only labels the steps: the grid has no insert marker.
    expect(document.querySelector(".pr-ruler")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".pr-ruler-marker")).toBeNull();

    clickAndFlush(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("6 selected")).toBeInTheDocument();
    clickAndFlush(screen.getByRole("button", { name: "Delete" }));
    const content = clip().content;
    expect(content.kind === "notes" ? content.events : null).toEqual([]);
    expect(history.entries).toHaveLength(1);

    const grid = document.querySelector(".step-editor-grid") as HTMLElement;
    expect(grid.style.getPropertyValue("--pr-step")).toBe("40px");
    clickAndFlush(screen.getByRole("button", { name: "Zoom in" }));
    expect(grid.style.getPropertyValue("--pr-step")).toBe("50px");

    clickAndFlush(screen.getByRole("button", { name: "Play" }));
    expect(onTogglePlay).toHaveBeenCalledOnce();
  });

  it("has the piano roll's Solo, which toggles the clip's track (#657)", () => {
    const { onToggleSolo } = renderRows();
    const solo = screen.getByRole("button", { name: "Solo" });
    expect(solo).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(solo);
    expect(onToggleSolo).toHaveBeenCalledOnce();
  });
});

describe("StepEditor velocity lane (#643)", () => {
  const stalks = () => [...document.querySelectorAll(".pr-stalk")] as HTMLElement[];

  /** Drags on the stalk for `step` (1-based) to velocity `to` (0..1). */
  function dragStalk(step: number, to: number): void {
    const strip = document.querySelector(".pr-velocity-strip") as HTMLElement;
    Object.defineProperty(strip, "clientHeight", { value: 100, configurable: true });
    const fire = (type: string, y: number) => {
      const init = {
        bubbles: true,
        button: 0,
        clientX: (step - 1) * 40 + 10,
        clientY: y,
      };
      fireEvent(strip, new MouseEvent(type, init));
      flush();
    };
    fire("pointerdown", 50);
    fire("pointermove", 100 - to * 100);
    fire("pointerup", 100 - to * 100);
  }

  function renderLane() {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks[0];
    const history = new CommandHistory(project);
    const [clip, setClip] = createSignal<Clip>(project.clips[0]);
    history.subscribe((snapshot) => setClip(snapshot.project.clips[0]));
    const [selectedIds, setSelectedIds] = createSignal<readonly EventId[]>([]);
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics.setAccountType("anonymous");
    render(() => (
      <StepEditor
        clip={clip()}
        project={project}
        instrument={track.instrument}
        dispatch={(commands) => history.execute(commands as never)}
        beginGesture={(options) => history.beginGesture(options)}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        analytics={analytics}
      />
    ));
    return { history, clip, transport, setSelectedIds };
  }

  it("shows the selected row's notes and no other row's", () => {
    renderLane();
    expect(stalks()).toHaveLength(4);
    clickAndFlush(screen.getByRole("button", { name: "CP" }));
    expect(stalks()).toHaveLength(2);
  });

  it("sets a note's velocity from its stalk, as one entry and one revision", () => {
    const { history, clip, transport } = renderLane();
    const revision = history.project.metadata.revision;
    dragStalk(5, 0.3);
    expect(velocityAt(clip(), 4 * 48)).toBeCloseTo(0.3);
    expect(history.entries).toHaveLength(1);
    expect(history.project.metadata.revision).toBe(revision + 1);
    // One drag, one clip_edited, through the catalog.
    expect(clipEditedEvents(transport)).toHaveLength(1);
    expect(clipEditedEvents(transport)[0].params.editor).toBe("step");
    const firstUse = transport.events.filter(
      (event) => event.name === "feature_first_use",
    );
    expect(firstUse.map((event) => event.params.feature)).toEqual(["velocity_lane"]);
  });

  it("shows the selected notes from every row, and the row's again when cleared", () => {
    const { setSelectedIds } = renderLane();
    const all = document.querySelectorAll(".step-cell.active").length;
    clickAndFlush(screen.getByRole("button", { name: "Select all" }));
    expect(stalks()).toHaveLength(all);
    expect(all).toBeGreaterThan(4);
    setSelectedIds([]);
    flush();
    expect(stalks()).toHaveLength(4);
  });

  it("moves every selected note together, whatever its row", () => {
    const { clip } = renderLane();
    clickAndFlush(screen.getByRole("button", { name: "Select all" }));
    dragStalk(1, 0.3);
    const content = clip().content;
    if (content.kind !== "notes") throw new Error("expected a note clip");
    expect(content.events.length).toBeGreaterThan(4);
    expect(content.events.every((note) => Math.round(note.velocity * 10) === 3)).toBe(
      true,
    );
  });
});

describe("StepEditor [+ Pad] row (#947)", () => {
  function renderWith(project: Project, onAddPad?: () => void) {
    const clip = project.clips[0];
    const track = project.song.tracks.find((candidate) => candidate.id === clip.trackId);
    const history = new CommandHistory(project);
    render(() => (
      <StepEditor
        clip={clip}
        project={project}
        instrument={track?.instrument ?? null}
        dispatch={(commands) => history.execute(commands as never)}
        beginGesture={(options) => history.beginGesture(options)}
        onAddPad={onAddPad}
      />
    ));
    return track;
  }

  const addPadButton = () =>
    screen.queryByRole("button", { name: "Add pad from library" });

  it("sits under a drum machine's last lane and asks for a new pad", () => {
    const onAddPad = vi.fn();
    const track = renderWith(createDrumMachineFixtureProject(), onAddPad);
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const button = addPadButton();
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Pad");
    // Placed one row under the lanes, wherever the kit ends.
    const grid = document.querySelector<HTMLElement>(".step-editor-grid");
    expect(grid?.style.getPropertyValue("--step-lane-count")).toBe(
      String(track.instrument.pads.length),
    );
    // It is not a lane: the lanes stay the kit's pads.
    expect(screen.getAllByRole("group", { name: /^Lane / })).toHaveLength(
      track.instrument.pads.length,
    );

    clickAndFlush(button as HTMLElement);
    expect(onAddPad).toHaveBeenCalledTimes(1);
  });

  it("is not offered without a handler, or on a track that is not a drum machine", () => {
    renderWith(createDrumMachineFixtureProject());
    expect(addPadButton()).toBeNull();
    cleanup();

    renderWith(createSliceFixtureProject(), vi.fn());
    expect(addPadButton()).toBeNull();
  });

  it("is disabled once the kit holds as many pads as a drum machine can", () => {
    const project = structuredClone(createDrumMachineFixtureProject());
    const track = project.song.tracks.find(
      (candidate) => candidate.id === project.clips[0].trackId,
    );
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [template] = track.instrument.pads;
    track.instrument.pads = Array.from({ length: 32 }, (_, index) => ({
      ...template,
      id: `pad_full${index}` as PadId,
      name: `Pad ${index + 1}`,
    }));
    const onAddPad = vi.fn();
    renderWith(project, onAddPad);

    const button = addPadButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A drum machine holds at most 32 pads");
  });
});
