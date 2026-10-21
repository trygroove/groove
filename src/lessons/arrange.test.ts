import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR } from "../domain/time";
import {
  applied,
  lessonContext,
  showBite,
  starterWorld,
  worldOf,
} from "../testing/lessonWorld";
import {
  ARRANGE_CHAPTER,
  BREAKDOWN,
  breakdownMade,
  DROP,
  END_BAR,
  everythingIn,
  INTRO,
  introMade,
  OUTRO,
  outroMade,
  SONG_BARS,
} from "./arrange";
import { bite, nextStep } from "./chapters";
import { arrangedDrums, clearSpan, partTrack, playsIn, songEnd } from "./parts";
import type { LessonSettings, LessonWorld } from "./types";

const settings: LessonSettings = { style: "four_on_the_floor" };

/** The starter grown into a four-bar loop: the beat, a bass, chords and a hook. */
function loopWorld(): LessonWorld {
  let world = starterWorld();
  for (const id of [
    "beat-snare",
    "beat-hats",
    "beat-loop",
    "bass-key",
    "bass-line",
    "chords-loop",
    "chords-hook",
  ] as const) {
    world = showBite(bite(id), world, settings);
  }
  return world;
}

const arrange = (id: string) => {
  const found = ARRANGE_CHAPTER.bites.find((one) => one.id === id);
  if (!found) throw new Error(id);
  return found;
};

const WHOLE = { from: 0, to: SONG_BARS };

describe("Arrange, subtractively (GRV-44)", () => {
  it("copies the whole loop out first, every part playing through every bar", () => {
    const loop = loopWorld();
    expect(everythingIn(loop.project, { from: 0, to: 4 })).toBe(true);
    expect(everythingIn(loop.project, WHOLE)).toBe(false);
    const copied = showBite(arrange("arrange-copy"), loop, settings);
    expect(everythingIn(copied.project, WHOLE)).toBe(true);
    expect(songEnd(copied.project)).toBe(SONG_BARS * TICKS_PER_BAR);
  });

  it("is an intro once no hook or chords clip plays in bars 1 to 8, and the beat still does", () => {
    const copied = showBite(arrange("arrange-copy"), loopWorld(), settings);
    const project = copied.project;
    const hook = partTrack(project, "hook");
    const chords = partTrack(project, "chords");
    if (!hook || !chords) throw new Error("no parts");
    expect(introMade(project)).toBe(false);
    // The hook out, but the chords still in: not yet.
    const hookOut = applied(
      project,
      clearSpan(project, [hook.id], INTRO, lessonContext(1)),
    );
    expect(playsIn(hookOut, hook.id, INTRO)).toBe(false);
    expect(introMade(hookOut)).toBe(false);
    const both = applied(
      hookOut,
      clearSpan(hookOut, [chords.id], INTRO, lessonContext(2)),
    );
    expect(introMade(both)).toBe(true);
    // An intro of silence is no intro: something has to play there.
    const silent = applied(
      both,
      clearSpan(
        both,
        both.song.tracks.map((track) => track.id),
        INTRO,
        lessonContext(3),
      ),
    );
    expect(introMade(silent)).toBe(false);
  });

  it("is a breakdown once no drum clip plays in bars 9 to 16, and something else does", () => {
    const copied = showBite(arrange("arrange-copy"), loopWorld(), settings);
    expect(breakdownMade(copied.project)).toBe(false);
    const after = showBite(arrange("arrange-breakdown"), copied, settings);
    for (const drums of arrangedDrums(after.project)) {
      expect(playsIn(after.project, drums.id, BREAKDOWN)).toBe(false);
      // Only the breakdown: the drums still play either side of it.
      expect(playsIn(after.project, drums.id, INTRO)).toBe(true);
      expect(playsIn(after.project, drums.id, DROP)).toBe(true);
    }
    expect(breakdownMade(after.project)).toBe(true);
  });

  it("hears the drop: done once the song plays inside it, bringing back what is missing first", () => {
    const copied = showBite(arrange("arrange-copy"), loopWorld(), settings);
    const drop = arrange("arrange-drop");
    // Everything already plays there: only the listening is left.
    expect(nextStep(drop, copied, settings)?.step.id).toBe("listen");
    const listen = drop.steps[1];
    expect(listen.done({ ...copied, playing: true, bar: 15 }, copied, settings)).toBe(
      false,
    );
    expect(listen.done({ ...copied, playing: false, bar: 16 }, copied, settings)).toBe(
      false,
    );
    expect(listen.done({ ...copied, playing: true, bar: 16 }, copied, settings)).toBe(
      true,
    );
    expect(listen.showMe(copied, settings, lessonContext())).toEqual({
      kind: "play",
      from: 12 * TICKS_PER_BAR,
    });

    const hook = partTrack(copied.project, "hook");
    if (!hook) throw new Error("no hook");
    const gone = worldOf(
      applied(
        copied.project,
        clearSpan(copied.project, [hook.id], DROP, lessonContext(4)),
      ),
    );
    expect(nextStep(drop, gone, settings)?.step.id).toBe("back");
    const back = showBite(drop, gone, settings);
    expect(everythingIn(back.project, DROP)).toBe(true);
  });

  it("ends on a short outro: nothing after bar 28, something in bars 25 to 28", () => {
    const copied = showBite(arrange("arrange-copy"), loopWorld(), settings);
    expect(outroMade(copied.project)).toBe(false);
    const after = showBite(arrange("arrange-outro"), copied, settings);
    expect(songEnd(after.project)).toBe(END_BAR * TICKS_PER_BAR);
    expect(everythingIn(after.project, OUTRO)).toBe(true);
    expect(outroMade(after.project)).toBe(true);
  });

  it("takes each section away by Show me alone, one deletion a bite", () => {
    let world = loopWorld();
    for (const one of ARRANGE_CHAPTER.bites) world = showBite(one, world, settings);
    const project = world.project;
    expect(introMade(project)).toBe(true);
    expect(breakdownMade(project)).toBe(true);
    expect(everythingIn(project, DROP)).toBe(true);
    expect(outroMade(project)).toBe(true);
  });
});
