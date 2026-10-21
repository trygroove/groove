import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { CommandHistory, noteEventsOf } from "../../commands";
import type { NoteEvent, Project } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import type { EventId, PadId } from "../../domain/ids";
import { clickAndFlush } from "../../testing/events";
import TrackClipEditor from "./TrackClipEditor";

afterEach(() => cleanup());

/**
 * The step grid's Transform panel over a real `CommandHistory` (#643): with
 * nothing selected it acts on the active row, and a selection spanning rows
 * is transformed whole.
 */
function renderDrums(padName: string) {
  const project = createDrumMachineFixtureProject();
  const history = new CommandHistory(project);
  const [current, setCurrent] = createSignal<Project>(project);
  history.subscribe((snapshot) => setCurrent(snapshot.project));
  const [selected, setSelected] = createSignal<readonly EventId[]>([]);
  const clip = () => current().clips[0];
  const track = () => current().song.tracks.find((t) => t.id === clip().trackId);
  const instrument = track()?.instrument;
  if (instrument?.kind !== "drumMachine") throw new Error("expected a drum machine");
  const pad = instrument.pads.find((candidate) => candidate.name === padName);
  if (!pad) throw new Error(`expected a ${padName} pad`);
  render(() => (
    <TrackClipEditor
      clip={clip()}
      showPianoRoll={() => false}
      instrument={track()?.instrument ?? null}
      dispatch={(commands) => history.execute(commands as never)}
      beginGesture={(options) => history.beginGesture(options)}
      editorPlaybackStep={() => null}
      selectedNoteIds={selected}
      setSelectedNoteIds={setSelected}
      project={current()}
      playheadTicks={0}
      registerPianoRollActions={() => {}}
      selectedPadId={pad.id as PadId}
    />
  ));
  const notes = (): readonly NoteEvent[] => noteEventsOf(clip()) ?? [];
  const onPad = (id: PadId) =>
    notes().filter((note) => note.trigger.kind === "pad" && note.trigger.padId === id);
  const other = instrument.pads.find((candidate) => candidate.id !== pad.id);
  if (!other) throw new Error("expected a second pad");
  return {
    notes,
    setSelected,
    row: () => onPad(pad.id),
    otherRow: () => onPad(other.id),
  };
}

const velocities = (notes: readonly NoteEvent[]) => notes.map((note) => note.velocity);

describe("TrackClipEditor transforms on the step grid (#643)", () => {
  it("varies only the active row when nothing is selected", () => {
    const { row, otherRow } = renderDrums("CP");
    const before = { row: velocities(row()), other: velocities(otherRow()) };
    expect(screen.getByText(`All ${row().length} notes in CP`)).toBeInTheDocument();

    clickAndFlush(screen.getByRole("button", { name: "Vary velocity" }));

    expect(velocities(row())).not.toEqual(before.row);
    expect(velocities(otherRow())).toEqual(before.other);
  });

  it("varies a selection that spans rows, whichever row is active", () => {
    const { row, otherRow, setSelected } = renderDrums("CP");
    const picked = [row()[0], otherRow()[0], otherRow()[1]];
    setSelected(picked.map((note) => note.id));
    flush();
    expect(screen.getByText("3 selected notes")).toBeInTheDocument();

    clickAndFlush(screen.getByRole("button", { name: "Vary velocity" }));

    const after = new Map(
      [...row(), ...otherRow()].map((note) => [note.id, note.velocity]),
    );
    for (const note of picked) expect(after.get(note.id)).not.toBe(note.velocity);
    // The rest of the other row is untouched.
    for (const note of otherRow().slice(2)) expect(note.velocity).toBe(0.8);
  });
});
