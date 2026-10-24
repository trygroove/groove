import { describe, expect, it } from "vitest";
import { setParameter } from "../commands/definitions/parameters";
import { addTrack } from "../commands/definitions/tracks";
import { createSynthInstrument, createTrack } from "../domain/factories";
import { SYNTH_FILTER_CUTOFF, SYNTH_WAVEFORM } from "../domain/parameters";
import {
  applied,
  applyShowMe,
  lessonContext,
  starterWorld,
} from "../testing/lessonWorld";
import { nextStep } from "./chapters";
import { DARK_CUTOFF_HZ, isPluck, lessonSynth, SOUND_CHAPTER } from "./sound";
import type { LessonStep, LessonWorld } from "./types";

const settings = { style: "four_on_the_floor" } as const;

function stepIn(id: string, world: LessonWorld): LessonStep {
  const bite = SOUND_CHAPTER.bites.find((one) => one.id === id);
  const next = bite && nextStep(bite, world, settings);
  if (!next) throw new Error(`${id} has no step`);
  return next.step;
}

/** The starter project with the synth Show me adds. */
function withSynth(): LessonWorld {
  let world = starterWorld();
  const step = stepIn("sound-wave", world);
  world = applyShowMe(world, step.showMe(world, settings, lessonContext()));
  return world;
}

describe("Shape a sound (GRV-43)", () => {
  it("teaches a wave, a filter and a pluck", () => {
    expect(SOUND_CHAPTER.bites.map((bite) => bite.title)).toEqual([
      "Pick a wave",
      "Darken it",
      "Make it a pluck",
    ]);
  });

  it("adds a synth with a riff to play first, when the song has none", () => {
    const world = starterWorld();
    const step = stepIn("sound-wave", world);
    expect(step.id).toBe("synth");
    const after = withSynth();
    expect(step.done(after, world, settings)).toBe(true);
    const synth = lessonSynth(after.project);
    expect(synth?.name).toBe("Synth");
    // The notes step is passed over: the synth came with a riff.
    expect(stepIn("sound-wave", after).id).toBe("wave");
  });

  it("asks for notes on a synth that has none", () => {
    const world = starterWorld();
    const context = lessonContext(5);
    const track = createTrack(context, {
      name: "Lead",
      order: 1,
      instrument: createSynthInstrument(),
    });
    const bare: LessonWorld = {
      ...world,
      project: applied(world.project, [addTrack(track)]),
    };
    const step = stepIn("sound-wave", bare);
    expect(step.id).toBe("notes");
    expect(step.done(bare, bare, settings)).toBe(false);
    const after = applyShowMe(bare, step.showMe(bare, settings, lessonContext()));
    expect(step.done(after, bare, settings)).toBe(true);
  });

  it("Pick a wave is done once the waveform changes, and Show me changes it", () => {
    const world = withSynth();
    const step = stepIn("sound-wave", world);
    const synth = lessonSynth(world.project);
    if (!synth) throw new Error("no synth");
    expect(step.target(world, settings)).toEqual({ entity: synth.id, param: "waveform" });
    expect(step.done(world, world, settings)).toBe(false);
    const after = applyShowMe(world, step.showMe(world, settings, lessonContext()));
    expect(step.done(after, world, settings)).toBe(true);
    // Set back to where it started, it is not done.
    const back = applied(after.project, [
      setParameter(
        { scope: "instrument", trackId: synth.id, parameterId: "waveform" },
        SYNTH_WAVEFORM.defaultValue,
      ),
    ]);
    expect(step.done({ ...after, project: back }, world, settings)).toBe(false);
  });

  it("Darken it holds once the cutoff is low", () => {
    const world = withSynth();
    const step = stepIn("sound-filter", world);
    const synth = lessonSynth(world.project);
    if (!synth) throw new Error("no synth");
    expect(step.done(world, world, settings)).toBe(false);
    const dark = applied(world.project, [
      setParameter(
        { scope: "instrument", trackId: synth.id, parameterId: "filterCutoff" },
        DARK_CUTOFF_HZ,
      ),
    ]);
    expect(step.done({ ...world, project: dark }, world, settings)).toBe(true);
    const shown = applyShowMe(world, step.showMe(world, settings, lessonContext()));
    expect(step.done(shown, world, settings)).toBe(true);
    expect(SYNTH_FILTER_CUTOFF.defaultValue).toBeGreaterThan(DARK_CUTOFF_HZ);
  });

  it("Make it a pluck holds for a short attack and decay with no sustain", () => {
    const world = withSynth();
    const step = stepIn("sound-pluck", world);
    const synth = lessonSynth(world.project);
    if (!synth) throw new Error("no synth");
    expect(isPluck(synth)).toBe(false);
    expect(step.done(world, world, settings)).toBe(false);
    const after = applyShowMe(world, step.showMe(world, settings, lessonContext()));
    expect(step.done(after, world, settings)).toBe(true);
    const half = applied(world.project, [
      setParameter(
        { scope: "instrument", trackId: synth.id, parameterId: "ampSustain" },
        0,
      ),
    ]);
    // The synth's attack and decay start short, so sustain down is enough.
    expect(step.done({ ...world, project: half }, world, settings)).toBe(true);
  });
});

describe("Shape a sound, started again on a shaped synth (GRV-190)", () => {
  /** The synth with the whole chapter done by Show me. */
  function shaped(): LessonWorld {
    let world = withSynth();
    for (const bite of SOUND_CHAPTER.bites) {
      let at = nextStep(bite, world, settings);
      while (at) {
        world = applyShowMe(world, at.step.showMe(world, settings, lessonContext()));
        at = nextStep(bite, world, settings, at.index);
      }
    }
    return world;
  }

  it("does not finish Darken it or Make it a pluck as they start", () => {
    const world = shaped();
    for (const id of ["sound-filter", "sound-pluck"]) {
      const step = stepIn(id, world);
      expect(["open", "ring"]).toContain(step.id);
      expect(step.done(world, world, settings)).toBe(false);
    }
  });

  it("opens the filter, then has the producer darken it again", () => {
    const world = shaped();
    const open = stepIn("sound-filter", world);
    const opened = applyShowMe(world, open.showMe(world, settings, lessonContext()));
    expect(open.done(opened, world, settings)).toBe(true);
    const bite = SOUND_CHAPTER.bites.find((one) => one.id === "sound-filter");
    if (!bite) throw new Error("no bite");
    const next = nextStep(bite, opened, settings, 1);
    expect(next?.step.id).toBe("cutoff");
    expect(next?.step.done(opened, opened, settings)).toBe(false);
  });

  it("lets the pluck ring again, then has the producer shape it", () => {
    const world = shaped();
    const ring = stepIn("sound-pluck", world);
    const ringing = applyShowMe(world, ring.showMe(world, settings, lessonContext()));
    expect(ring.done(ringing, world, settings)).toBe(true);
    const synth = lessonSynth(ringing.project);
    expect(synth && isPluck(synth)).toBe(false);
  });
});
