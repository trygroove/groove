import { describe, expect, it } from "vitest";
import { addNotes } from "../commands/definitions/notes";
import { createNoteEvent } from "../domain/factories";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import {
  applied,
  lessonContext,
  showBite,
  starterWorld,
  worldOf,
} from "../testing/lessonWorld";
import { CHORDS_CHAPTER, chordLoop, hookWritten } from "./chords";
import { noteClips } from "./drums";
import { partTrack } from "./parts";
import { isPluck } from "./sound";
import { isSynthTrack } from "./synthParts";
import type { LessonSettings } from "./types";

const settings: LessonSettings = { style: "trap" };
const bite = (id: string) => {
  const found = CHORDS_CHAPTER.bites.find((one) => one.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** The starter with an empty Chords and Hook track, in F minor (trap's key). */
function withParts() {
  const context = lessonContext(31);
  let world = starterWorld();
  for (const role of ["chords", "hook"] as const) {
    const step = bite(role === "chords" ? "chords-loop" : "chords-hook").steps[0];
    const shown = step.showMe(world, settings, context);
    if (shown?.kind !== "commands") throw new Error(role);
    world = worldOf(applied(world.project, shown.commands));
  }
  return world;
}

/** `pitches` starting together on beat `beat` of the bar (from 0), a beat long. */
function chordAt(beat: number, pitches: readonly number[], seed: number) {
  const context = lessonContext(seed);
  return pitches.map((pitch) =>
    createNoteEvent(context, {
      startTicks: beat * 4 * TICKS_PER_SIXTEENTH,
      durationTicks: 4 * TICKS_PER_SIXTEENTH,
      pitch,
    }),
  );
}

describe("Chords and hook (GRV-44)", () => {
  it("is a chord loop once two different chords in the key play, and not one alone", () => {
    const world = withParts();
    const chords = partTrack(world.project, "chords");
    const clip = chords && noteClips(world.project, chords)[0];
    if (!clip) throw new Error("no clip");
    // F minor: Fm, then D♭.
    const one = applied(world.project, [addNotes(clip.id, chordAt(0, [53, 56, 60], 1))]);
    expect(chordLoop(one, settings)).toBe(false);
    const two = applied(one, [addNotes(clip.id, chordAt(2, [49, 53, 56], 2))]);
    expect(chordLoop(two, settings)).toBe(true);
    // An A natural is not in F minor.
    const off = applied(two, [addNotes(clip.id, chordAt(3, [57, 60, 64], 3))]);
    expect(chordLoop(off, settings)).toBe(false);
  });

  it("is a hook once four or more single notes in the key play, never a chord", () => {
    const world = withParts();
    const hook = partTrack(world.project, "hook");
    const clip = hook && noteClips(world.project, hook)[0];
    if (!clip) throw new Error("no clip");
    const context = lessonContext(9);
    const notes = [65, 68, 72, 70].map((pitch, step) =>
      createNoteEvent(context, {
        startTicks: step * 2 * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        pitch,
      }),
    );
    expect(
      hookWritten(
        applied(world.project, [addNotes(clip.id, notes.slice(0, 3))]),
        settings,
      ),
    ).toBe(false);
    expect(
      hookWritten(applied(world.project, [addNotes(clip.id, notes)]), settings),
    ).toBe(true);
    const chord = applied(world.project, [
      addNotes(clip.id, chordAt(0, [65, 68, 72, 77], 4)),
    ]);
    expect(hookWritten(chord, settings)).toBe(false);
  });

  it("Show me writes four bars of chords and a hook in the key, on tracks of their own", () => {
    let world = starterWorld();
    for (const id of ["chords-loop", "chords-hook", "chords-pluck"]) {
      world = showBite(bite(id), world, settings);
    }
    expect(chordLoop(world.project, settings)).toBe(true);
    expect(hookWritten(world.project, settings)).toBe(true);
    const hook = partTrack(world.project, "hook");
    if (!hook || !isSynthTrack(hook)) throw new Error("no synth hook");
    expect(isPluck(hook)).toBe(true);
    expect(world.project.song.tracks.map((track) => track.name)).toEqual([
      "BD",
      "Chords",
      "Hook",
    ]);
    // Both run the four bars of the loop from bar 1.
    for (const track of [partTrack(world.project, "chords"), hook]) {
      const placed = world.project.song.placements.filter((p) => p.trackId === track?.id);
      expect(placed).toEqual([
        expect.objectContaining({ startTicks: 0, durationTicks: 4 * TICKS_PER_BAR }),
      ]);
    }
  });

  it("writes over what a part already plays in the loop's bars", () => {
    const world = withParts();
    const twice = showBite(
      bite("chords-loop"),
      showBite(bite("chords-loop"), world, settings),
      settings,
    );
    const chords = partTrack(twice.project, "chords");
    expect(
      twice.project.song.placements.filter((p) => p.trackId === chords?.id),
    ).toHaveLength(1);
  });
});
