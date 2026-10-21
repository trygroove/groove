import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import type { Clip } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { clickAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import GeneratePanel from "./GeneratePanel";
import { rowNotes } from "./generatedRow";
import { lanesFor } from "./stepEditorModel";

afterEach(() => cleanup());

/** The drum fixture's clip (BD 1/5/9/13, CP 5/13), generating into CP. */
function setUp(options: { consent?: boolean; random?: () => number } = {}) {
  const project = createDrumMachineFixtureProject();
  const [kick, clap] = lanesFor(project.song.tracks[0].instrument);
  const history = new CommandHistory(project);
  const [clip, setClip] = createSignal<Clip>(project.clips[0]);
  history.subscribe((snapshot) => setClip(snapshot.project.clips[0]));
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.consent === false) consent.set({ productAnalytics: false });
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  const onPreview = vi.fn();
  render(() => (
    <GeneratePanel
      clip={clip()}
      row={clap}
      dispatch={(commands) => history.execute(commands as never)}
      onPreview={onPreview}
      analytics={analytics}
      ids={createSeededIdFactory(9)}
      random={options.random}
    />
  ));
  const on = (lane: typeof kick) =>
    rowNotes(clip(), lane.trigger)
      .map((note) => note.startTicks / TICKS_PER_SIXTEENTH + 1)
      .sort((a, b) => a - b);
  const events = (name: string) =>
    transport.events.filter((event) => event.name === name);
  return { history, clip, kick: () => on(kick), clap: () => on(clap), events, onPreview };
}

const panel = () => within(screen.getByRole("region", { name: "Generate" }));
const press = (name: string) => clickAndFlush(panel().getByRole("button", { name }));
function setField(name: string, value: string): void {
  const field = panel().getByRole("spinbutton", { name });
  fireEvent.input(field, { target: { value } });
  flush();
}

describe("GeneratePanel (#643)", () => {
  it("names the row it writes into", () => {
    setUp();
    expect(screen.getByRole("region", { name: "Generate" })).toHaveTextContent("into CP");
  });

  it.each([
    ["Four on the floor", [1, 5, 9, 13]],
    ["Offbeats", [3, 7, 11, 15]],
    ["Backbeat", [5, 13]],
    ["Eighths", [1, 3, 5, 7, 9, 11, 13, 15]],
    ["Sixteenths", Array.from({ length: 16 }, (_, step) => step + 1)],
  ])("writes %s into the selected row only, as one undo entry", (name, steps) => {
    const { history, kick, clap } = setUp();
    press(name);
    expect(clap()).toEqual(steps);
    expect(kick()).toEqual([1, 5, 9, 13]);
    expect(history.entries).toHaveLength(1);
    history.undo();
    flush();
    expect(clap()).toEqual([5, 13]);
  });

  it("writes k of n Euclidean hits, rotated, repeated through the clip", () => {
    const { history, clap, kick, onPreview } = setUp();
    setField("Steps", "8");
    setField("Hits", "3");
    // Focusing the generator previews it first, and changes nothing.
    fireEvent.focusIn(panel().getByRole("spinbutton", { name: "Hits" }));
    flush();
    const preview = onPreview.mock.lastCall?.[0] as { step: number }[];
    expect(preview.map((hit) => hit.step)).toEqual([0, 3, 6, 8, 11, 14]);
    expect(history.entries).toHaveLength(0);
    press("Write Euclidean");
    expect(clap()).toEqual([1, 4, 7, 9, 12, 15]);
    expect(kick()).toEqual([1, 5, 9, 13]);
    expect(history.entries).toHaveLength(1);

    setField("Rotate", "1");
    press("Write Euclidean");
    expect(clap()).toEqual([2, 5, 8, 10, 13, 16]);
    expect(history.entries).toHaveLength(2);
  });

  it("keeps Hits within Steps", () => {
    setUp();
    setField("Steps", "4");
    expect(panel().getByRole("spinbutton", { name: "Hits" })).toHaveAttribute("max", "4");
    setField("Hits", "9");
    fireEvent.change(panel().getByRole("spinbutton", { name: "Hits" }));
    flush();
    expect(panel().getByRole("spinbutton", { name: "Hits" })).toHaveValue(4);
  });

  it("writes random hits by density over a stable roll, until New roll", () => {
    let seed = 3;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const { history, clap } = setUp({ random });
    const density = panel().getByRole("slider");
    fireEvent.input(density, { target: { value: "30" } });
    flush();
    press("Write random");
    const sparse = clap();
    fireEvent.input(density, { target: { value: "70" } });
    flush();
    press("Write random");
    expect(clap()).toEqual(expect.arrayContaining(sparse));
    expect(clap().length).toBeGreaterThan(sparse.length);
    expect(history.entries).toHaveLength(2);

    const before = clap();
    press("New roll");
    press("Write random");
    expect(clap()).not.toEqual(before);
  });

  it("clears only the selected row, as one undo entry", () => {
    const { history, clap, kick } = setUp();
    press("Clear row");
    expect(clap()).toEqual([]);
    expect(kick()).toEqual([1, 5, 9, 13]);
    expect(history.entries).toHaveLength(1);
  });

  it("previews on hover and focus, without changing the project", () => {
    const { history, onPreview } = setUp();
    const revision = history.project.metadata.revision;
    fireEvent.pointerEnter(panel().getByRole("button", { name: "Offbeats" }));
    flush();
    expect(onPreview.mock.lastCall?.[0].map((hit: { step: number }) => hit.step)).toEqual(
      [2, 6, 10, 14],
    );
    fireEvent.pointerLeave(screen.getByRole("region", { name: "Generate" }));
    flush();
    expect(onPreview).toHaveBeenLastCalledWith(null);

    fireEvent.focusIn(panel().getByRole("button", { name: "Clear row" }));
    flush();
    expect(onPreview).toHaveBeenLastCalledWith([]);
    expect(history.project.metadata.revision).toBe(revision);
    expect(history.entries).toHaveLength(0);
  });

  it("logs each generate once through the catalog, by kind of generator", () => {
    // A fixed roll that always hits: an unseeded one empties the row about
    // one run in a thousand, leaving "Clear row" nothing to write or log.
    const { events } = setUp({ random: () => 0 });
    press("Offbeats");
    press("Backbeat");
    press("Write Euclidean");
    press("Write random");
    press("Clear row");
    expect(events("clip_edited")).toHaveLength(5);
    expect(events("clip_edited").every((event) => event.params.editor === "step")).toBe(
      true,
    );
    expect(events("feature_first_use").map((event) => event.params.feature)).toEqual([
      "step_pattern",
      "step_euclidean",
      "step_random",
      "step_clear_row",
    ]);
  });

  it("still writes with analytics disabled, sending nothing", () => {
    const { clap, events } = setUp({ consent: false });
    press("Offbeats");
    expect(clap()).toEqual([3, 7, 11, 15]);
    expect(events("clip_edited")).toHaveLength(0);
  });

  it("hands the preview to a host that keeps it in a signal", () => {
    const project = createDrumMachineFixtureProject();
    const [, clap] = lanesFor(project.song.tracks[0].instrument);
    const [preview, setPreview] = createSignal<readonly { step: number }[] | null>(null);
    render(() => (
      <GeneratePanel
        clip={project.clips[0]}
        row={clap}
        dispatch={() => undefined}
        onPreview={setPreview}
      />
    ));
    fireEvent.pointerEnter(panel().getByRole("button", { name: "Backbeat" }));
    flush();
    expect(preview()?.map((hit) => hit.step)).toEqual([4, 12]);
  });

  it("offers nothing to press while there is no row to write into", () => {
    const project = createDrumMachineFixtureProject();
    render(() => (
      <GeneratePanel clip={project.clips[0]} row={null} dispatch={() => undefined} />
    ));
    expect(panel().getByRole("button", { name: "Offbeats" })).toBeDisabled();
    expect(panel().getByRole("button", { name: "Clear row" })).toBeDisabled();
  });
});
