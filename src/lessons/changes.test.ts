import { describe, expect, it } from "vitest";
import { addNotes } from "../commands/definitions/notes";
import { setParameter } from "../commands/definitions/parameters";
import { updatePlacement } from "../commands/definitions/placements";
import { removeTrack } from "../commands/definitions/tracks";
import { createNoteEvent } from "../domain/factories";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH, toTicks } from "../domain/time";
import {
  applied,
  applyShowMe,
  lessonContext,
  starterWorld,
} from "../testing/lessonWorld";
import { describeChanges, MAX_CHANGE_LINES } from "./changes";
import { chapter, nextStep } from "./chapters";
import { beatTrack, kickPad } from "./drums";

describe("what the producer changed (GRV-43)", () => {
  it("says nothing when nothing changed", () => {
    const { project } = starterWorld();
    expect(describeChanges(project, project)).toEqual([]);
  });

  it("names the steps of hits added, and calls a soft one a ghost note", () => {
    const { project } = starterWorld();
    const track = beatTrack(project);
    const pad = track && kickPad(track);
    const clip = project.clips[0];
    if (!track || !pad || !clip) throw new Error("no beat");
    const context = lessonContext();
    const after = applied(project, [
      addNotes(clip.id, [
        createNoteEvent(context, {
          startTicks: 10 * TICKS_PER_SIXTEENTH,
          durationTicks: TICKS_PER_SIXTEENTH,
          padId: pad.id,
        }),
        createNoteEvent(context, {
          startTicks: 7 * TICKS_PER_SIXTEENTH,
          durationTicks: TICKS_PER_SIXTEENTH,
          padId: pad.id,
          velocity: 0.3,
        }),
      ]),
    ]);
    expect(describeChanges(project, after)).toEqual([
      "BD's BD: hits added on step 8 and step 11 (1 soft, a ghost note).",
    ]);
    expect(describeChanges(after, project)).toEqual([
      "BD's BD: hits removed from step 8 and step 11.",
    ]);
  });

  it("names a new pad and its sound, a synth's changed controls, the tempo and a longer loop", () => {
    const world = starterWorld();
    const snare = nextStep(chapter("beat").bites[3], world, { style: "boom_bap" });
    const withSnare = applyShowMe(
      world,
      snare?.step.showMe(world, { style: "boom_bap" }, lessonContext()) ?? null,
    );
    const lines = describeChanges(world.project, withSnare.project);
    expect(lines[0]).toMatch(/^Added a pad, Snare, to BD, playing "/);
    expect(lines[1]).toBe("BD's Snare: hits added on step 5 and step 13.");

    const placement = world.project.song.placements[0];
    const longer = applied(world.project, [
      setParameter({ scope: "song", parameterId: "song.tempo" }, 90),
      updatePlacement(placement.id, {
        durationTicks: toTicks(4 * TICKS_PER_BAR),
        looped: true,
      }),
    ]);
    expect(describeChanges(world.project, longer)).toEqual([
      "Tempo: 120 to 90 BPM.",
      "BD's clips now play for 4 bars (were 1 bar).",
    ]);

    const sound = chapter("sound").bites[0];
    const withSynth = applyShowMe(
      world,
      nextStep(sound, world, { style: "trap" })?.step.showMe(
        world,
        { style: "trap" },
        lessonContext(),
      ) ?? null,
    );
    const synthLines = describeChanges(world.project, withSynth.project);
    expect(synthLines[0]).toBe('Added a synth track, "Synth".');
    expect(synthLines[1]).toBe("Synth: 8 notes added.");
    const synth = withSynth.project.song.tracks.find((track) => track.name === "Synth");
    if (!synth) throw new Error("no synth");
    const square = applied(withSynth.project, [
      setParameter(
        { scope: "instrument", trackId: synth.id, parameterId: "waveform" },
        1,
      ),
    ]);
    expect(describeChanges(withSynth.project, square)).toEqual([
      "Synth's waveform: sawtooth to square.",
    ]);
  });

  it("says when a track went, and stops at a handful of lines", () => {
    const { project } = starterWorld();
    const without = applied(project, [removeTrack(project.song.tracks[0].id)]);
    expect(describeChanges(project, without)[0]).toBe(
      'Removed the drum machine track "BD".',
    );
    expect(describeChanges(project, without).length).toBeLessThanOrEqual(
      MAX_CHANGE_LINES,
    );
  });
});
