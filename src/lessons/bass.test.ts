import { describe, expect, it } from "vitest";
import { setKey } from "../commands/definitions/key";
import { addNotes } from "../commands/definitions/notes";
import { createNoteEvent } from "../domain/factories";
import { TICKS_PER_SIXTEENTH } from "../domain/time";
import {
  applied,
  applyShowMe,
  lessonContext,
  starterWorld,
  worldOf,
} from "../testing/lessonWorld";
import { BASS_CHAPTER, bassUnderKick, kickSteps, ROUND_CUTOFF_HZ } from "./bass";
import { nextStep } from "./chapters";
import { noteClips } from "./drums";
import { partTrack } from "./parts";
import { isSynthTrack, synthCutoff } from "./synthParts";
import type { LessonSettings, LessonWorld } from "./types";

const settings: LessonSettings = { style: "boom_bap" };
const bite = (id: string) => {
  const found = BASS_CHAPTER.bites.find((one) => one.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** Every applicable step of `id`, done by Show me, from `world`. */
function showAll(id: string, world: LessonWorld): LessonWorld {
  let now = world;
  let at = nextStep(bite(id), now, settings);
  let seed = 200;
  while (at) {
    now = applyShowMe(now, at.step.showMe(now, settings, lessonContext(seed++)));
    expect(at.step.done(now, world, settings)).toBe(true);
    at = nextStep(bite(id), now, settings, at.index);
  }
  return now;
}

describe("Bass (GRV-44)", () => {
  it("adds a Bass track first in a song that has none, then sets the genre's key", () => {
    const world = starterWorld();
    expect(nextStep(bite("bass-key"), world, settings)?.step.id).toBe("bass");
    const after = showAll("bass-key", world);
    expect(partTrack(after.project, "bass")?.name).toBe("Bass");
    // Boom bap writes in C minor.
    expect(after.project.song.key).toEqual({ root: 0, scale: "minor" });
    expect(bite("bass-key").made?.(after, settings)).toBe(true);
  });

  it("is done once the song is in the key it asks for, not any other", () => {
    const withBass = applyShowMe(
      starterWorld(),
      nextStep(bite("bass-key"), starterWorld(), settings)?.step.showMe(
        starterWorld(),
        settings,
        lessonContext(7),
      ) ?? null,
    );
    const step = nextStep(bite("bass-key"), withBass, settings);
    if (step?.step.id !== "key") throw new Error("no key step");
    const done = (key: Parameters<typeof setKey>[0]) =>
      step.step.done(
        worldOf(applied(withBass.project, [setKey(key)])),
        withBass,
        settings,
      );
    // Boom bap asks for C minor: A minor or C major is not it.
    expect(done({ root: 9, scale: "minor" })).toBe(false);
    expect(done({ root: 0, scale: "major" })).toBe(false);
    expect(done({ root: 0, scale: "minor" })).toBe(true);
  });

  it("counts any key the producer picks, and keeps it", () => {
    const withBass = showAll("bass-key", starterWorld());
    const theirs = worldOf(
      applied(withBass.project, [setKey({ root: 2, scale: "dorian" })]),
    );
    expect(bite("bass-key").made?.(theirs, settings)).toBe(true);
    const line = showAll("bass-line", theirs);
    const bass = partTrack(line.project, "bass");
    if (!bass) throw new Error("no bass");
    const notes = noteClips(line.project, bass)[0];
    // D dorian's root, D2.
    expect(notes.content.kind === "notes" && notes.content.events[0].trigger).toEqual({
      kind: "pitch",
      pitch: 38,
    });
  });

  it("reads the kick's steps off the beat, every beat when there is no kick", () => {
    expect(kickSteps(starterWorld().project)).toEqual([0, 4, 8, 12]);
  });

  it("is a bassline under the kick once a low, in-key note starts on every kick step", () => {
    const keyed = showAll("bass-key", starterWorld());
    expect(bassUnderKick(keyed.project, settings)).toBe(false);
    const bass = partTrack(keyed.project, "bass");
    const clip = bass && noteClips(keyed.project, bass)[0];
    if (!clip) throw new Error("no clip");
    const context = lessonContext(7);
    const at = (step: number, pitch: number) =>
      createNoteEvent(context, {
        startTicks: step * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        pitch,
      });
    // Three of the four kicks: not yet.
    const three = applied(keyed.project, [
      addNotes(clip.id, [at(0, 36), at(4, 36), at(8, 39)]),
    ]);
    expect(bassUnderKick(three, settings)).toBe(false);
    const four = applied(three, [addNotes(clip.id, [at(12, 43)])]);
    expect(bassUnderKick(four, settings)).toBe(true);
    // An off-key note (E is not in C minor) undoes it, and so does a high one.
    expect(
      bassUnderKick(applied(four, [addNotes(clip.id, [at(14, 40)])]), settings),
    ).toBe(false);
    expect(
      bassUnderKick(applied(four, [addNotes(clip.id, [at(14, 72)])]), settings),
    ).toBe(false);
  });

  it("Show me writes the root under every kick, taking out what does not fit", () => {
    const keyed = showAll("bass-key", starterWorld());
    const bass = partTrack(keyed.project, "bass");
    const clip = bass && noteClips(keyed.project, bass)[0];
    if (!clip) throw new Error("no clip");
    const stray = applied(keyed.project, [
      addNotes(clip.id, [
        createNoteEvent(lessonContext(8), {
          startTicks: 0,
          durationTicks: 48,
          pitch: 76,
        }),
      ]),
    ]);
    const after = showAll("bass-line", worldOf(stray));
    expect(bassUnderKick(after.project, settings)).toBe(true);
  });

  it("rounds the bass off under the cutoff it asks for", () => {
    const after = showAll("bass-sound", starterWorld());
    const bass = partTrack(after.project, "bass");
    if (!bass || !isSynthTrack(bass)) throw new Error("no synth bass");
    expect(synthCutoff(bass)).toBeLessThanOrEqual(ROUND_CUTOFF_HZ);
  });
});
