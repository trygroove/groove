import { cleanup, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { setKey, updateClip } from "../../commands";
import { MAX_CLIP_LENGTH_TICKS } from "../../domain/clipLength";
import { toTicks } from "../../domain/time";
import {
  clickTransform,
  currentNotes,
  pitches,
  pitchOf,
  setOption,
  setUpTransformPanel as setUp,
} from "./transformPanelHarness";

afterEach(() => cleanup());

/**
 * What each of the six CLP-04 transformations does to a clip when the user
 * clicks it. The history and analytics contract has its own suite
 * (`TransformPanel.history.test.tsx`).
 */
describe("TransformPanel (CLP-04)", () => {
  it("transposes the whole clip when nothing is selected", async () => {
    const { session, renderPanel } = await setUp();
    const before = pitches(session);
    renderPanel([]);

    clickTransform("Transpose");

    expect(pitches(session)).toEqual(before.map((pitch) => pitch + 12));
  });

  it("transposes only the selected notes", async () => {
    const { session, renderPanel } = await setUp();
    const before = new Map(
      currentNotes(session).map((event) => [event.id, pitchOf(event)]),
    );
    const target = currentNotes(session)[0];
    renderPanel([target.id]);

    clickTransform("Transpose");

    // The selected note moved by the panel's semitone value; every other note
    // is exactly where it was.
    for (const event of currentNotes(session)) {
      const expected = before.get(event.id) ?? -1;
      expect(pitchOf(event)).toBe(event.id === target.id ? expected + 12 : expected);
    }
  });

  it("varies velocity within 20% of each note's own, through the shared command", async () => {
    const { session, renderPanel } = await setUp();
    const before = new Map(
      currentNotes(session).map((event) => [event.id, event.velocity]),
    );
    renderPanel([]);

    clickTransform("Vary velocity");

    for (const event of currentNotes(session)) {
      const was = before.get(event.id) ?? 0;
      expect(Math.abs(event.velocity - was)).toBeLessThanOrEqual(was * 0.2 + 1e-9);
      expect(event.velocity).toBeLessThanOrEqual(1);
    }
  });

  it("quantizes onto the 16th grid", async () => {
    const { session, renderPanel } = await setUp();
    renderPanel([]);

    clickTransform("Quantize");

    for (const event of currentNotes(session)) {
      expect(event.startTicks % 48).toBe(0);
    }
  });

  it("doubles the whole clip, whatever is selected (#647)", async () => {
    const { session, renderPanel } = await setUp();
    const before = currentNotes(session).length;
    const length = session.project.clips[0].lengthTicks;
    renderPanel([currentNotes(session)[0].id]);

    clickTransform("Double");

    expect(currentNotes(session)).toHaveLength(before * 2);
    expect(session.project.clips[0].lengthTicks).toBe(length * 2);
    // One undo takes back the copies and the length together.
    session.undo();
    expect(currentNotes(session)).toHaveLength(before);
    expect(session.project.clips[0].lengthTicks).toBe(length);
  });

  it("clears every note in the clip", async () => {
    const { session, renderPanel } = await setUp();
    renderPanel([]);

    clickTransform("Clear clip");

    expect(currentNotes(session)).toHaveLength(0);
  });

  it("disables every transformation when the clip has no notes", async () => {
    const { session, renderPanel } = await setUp();
    renderPanel([]);
    clickTransform("Clear clip");
    cleanup();
    renderPanel([]);

    expect(currentNotes(session)).toHaveLength(0);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("surfaces a boundary rejection instead of clamping the notes", async () => {
    const { session, renderPanel } = await setUp();
    const before = pitches(session);
    renderPanel([]);

    // The fixture's top note is C5; repeated +24 transposes eventually leave
    // the 0-127 range, and the command refuses rather than clamping.
    setOption("Semitones", "24");
    for (let index = 0; index < 4; index += 1) clickTransform("Transpose");

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).not.toBe("");
    // The command layer's own issue text names clip/event IDs and raw ticks.
    // That is right for a log and wrong for a person, so the panel says what
    // to change instead of echoing it.
    expect(alert).not.toMatch(/\b(clp|evt|trk)_/);
    expect(alert).toMatch(/semitones/i);

    // The refused transformation left every note where the last accepted one
    // put it: nothing was clamped to the edge of the range.
    expect(pitches(session).every((pitch) => pitch <= 127)).toBe(true);
    expect(pitches(session)).not.toEqual(before);
  });

  it("labels its scope: the whole clip, or the selection", async () => {
    const { session, renderPanel } = await setUp();
    renderPanel([]);
    expect(screen.getByText("All 4 notes")).toBeInTheDocument();
    cleanup();
    renderPanel([currentNotes(session)[0].id, currentNotes(session)[1].id]);
    expect(screen.getByText("2 selected notes")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Transform" })).toBeInTheDocument();
  });

  it("halves the clip, whatever is selected, and stops at one bar (#662)", async () => {
    const { session, renderPanel } = await setUp();
    const length = session.project.clips[0].lengthTicks;
    renderPanel([currentNotes(session)[0].id]);

    clickTransform("Halve");

    expect(session.project.clips[0].lengthTicks).toBe(length / 2);
    // The fixture is two bars, so one bar is left, and Halve goes no further.
    cleanup();
    renderPanel([]);
    expect(screen.getByRole("button", { name: "Halve" })).toBeDisabled();
    session.undo();
    expect(session.project.clips[0].lengthTicks).toBe(length);
  });

  it("refuses Double at the longest clip length, changing nothing", async () => {
    const { session, renderPanel, transport } = await setUp();
    session.dispatch(
      updateClip(session.project.clips[0].id, {
        lengthTicks: toTicks(MAX_CLIP_LENGTH_TICKS),
      }),
    );
    const before = currentNotes(session);
    renderPanel([]);

    clickTransform("Double");

    expect(currentNotes(session)).toEqual(before);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This clip is already as long as a clip can be, so it cannot double.",
    );
    const failed = transport.events.filter((event) => event.name === "note_edit_failed");
    expect(failed.map((event) => event.params.operation)).toEqual(["double"]);
  });

  it("offers Quantize to scale in the piano roll, off while the key is chromatic", async () => {
    const { session, renderPanel } = await setUp();
    renderPanel([]);
    expect(screen.getByRole("button", { name: "Quantize to scale" })).toBeDisabled();
    cleanup();

    // C minor: the fixture's E3 is its one stray note, and it moves to D#3.
    session.dispatch(setKey({ root: 0, scale: "minor" }));
    renderPanel([]);
    clickTransform("Quantize to scale");
    expect(pitches(session)).toEqual([60, 63, 67, 72]);
  });

  it("shows its values formatted, and puts back one that does not read", async () => {
    const { renderPanel } = await setUp();
    renderPanel([]);
    const semitones = screen.getByLabelText("Semitones") as HTMLInputElement;
    expect(semitones).toHaveValue("+12 st");
    // Semitones is the panel's only field now: the Varies take none (#653).
    expect(screen.getAllByRole("textbox")).toEqual([semitones]);

    setOption("Semitones", "-5");
    await Promise.resolve();
    expect(semitones).toHaveValue("−5 st");
    setOption("Semitones", "lots");
    await Promise.resolve();
    expect(semitones).toHaveValue("−5 st");
    expect(semitones).toHaveAttribute("aria-invalid", "true");
  });
});
