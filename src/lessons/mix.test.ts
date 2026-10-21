import { describe, expect, it } from "vitest";
import { setDeviceBypass } from "../commands/definitions/devices";
import { setParameter } from "../commands/definitions/parameters";
import { TRACK_VOLUME } from "../domain/parameters";
import { TICKS_PER_BAR } from "../domain/time";
import {
  applied,
  lessonContext,
  showBite,
  starterWorld,
  worldOf,
} from "../testing/lessonWorld";
import { bite, nextStep } from "./chapters";
import {
  balanced,
  hookSent,
  kickLevel,
  MIX_CHAPTER,
  panned,
  reverbReturn,
  WATCH_BARS,
} from "./mix";
import { partTrack } from "./parts";
import type { LessonSettings, LessonWorld } from "./types";

const settings: LessonSettings = { style: "boom_bap" };

/** The starter with a beat, a bass, chords and a hook, all at 0 dB. */
function partsWorld(): LessonWorld {
  let world = starterWorld();
  for (const id of ["beat-hats", "bass-line", "chords-loop", "chords-hook"] as const) {
    world = showBite(bite(id), world, settings);
  }
  return world;
}

const mix = (id: string) => {
  const found = MIX_CHAPTER.bites.find((one) => one.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("Mix and export (GRV-44)", () => {
  it("is balanced once the hook and the chords sit under both the kick and the bass", () => {
    const world = partsWorld();
    expect(kickLevel(world.project)).toBe(0);
    expect(balanced(world.project)).toBe(false);
    const hook = partTrack(world.project, "hook");
    const chords = partTrack(world.project, "chords");
    const bass = partTrack(world.project, "bass");
    if (!hook || !chords || !bass) throw new Error("no parts");
    const volume = (id: typeof hook.id, value: number) =>
      setParameter({ scope: "track", trackId: id, parameterId: TRACK_VOLUME.id }, value);
    const hookDown = applied(world.project, [volume(hook.id, -6)]);
    expect(balanced(hookDown)).toBe(false);
    const both = applied(hookDown, [volume(chords.id, -8)]);
    expect(balanced(both)).toBe(true);
    // The bass pulled under the hook undoes it: the bass is meant to be loudest.
    expect(balanced(applied(both, [volume(bass.id, -9)]))).toBe(false);
    expect(balanced(showBite(mix("mix-balance"), world, settings).project)).toBe(true);
  });

  it("is panned once the hats and the chords are both off centre", () => {
    const world = partsWorld();
    expect(panned(world.project)).toBe(false);
    const after = showBite(mix("mix-pan"), world, settings);
    expect(panned(after.project)).toBe(true);
    expect(partTrack(after.project, "chords")?.mixer.pan).toBeGreaterThan(0);
  });

  it("sends the hook to a reverb on a return, adding the return first when there is none", () => {
    const world = partsWorld();
    expect(nextStep(mix("mix-reverb"), world, settings)?.step.id).toBe("return");
    const after = showBite(mix("mix-reverb"), world, settings);
    const bus = reverbReturn(after.project);
    expect(bus?.devices.map((device) => device.type)).toEqual(["reverb"]);
    expect(hookSent(after.project)).toBe(true);
    // A bypassed reverb is no reverb.
    const device = bus?.devices[0];
    if (!bus || !device) throw new Error("no reverb");
    const bypassed = applied(after.project, [
      setDeviceBypass({ chain: "return", returnId: bus.id }, device.id, true),
    ]);
    expect(hookSent(bypassed)).toBe(false);
    // With a reverb return already there, the bite is only the send.
    expect(nextStep(mix("mix-reverb"), worldOf(after.project), settings)?.step.id).toBe(
      "send",
    );
  });

  it("watches the master for four bars of play without it going red", () => {
    const world = partsWorld();
    const watch = mix("mix-master").steps[0];
    const playing = { ...world, playing: true };
    expect(watch.done({ ...playing, barsHeard: WATCH_BARS - 1 }, world, settings)).toBe(
      false,
    );
    expect(watch.done({ ...playing, barsHeard: WATCH_BARS }, world, settings)).toBe(true);
    expect(
      watch.done({ ...playing, barsHeard: WATCH_BARS, masterClips: 1 }, world, settings),
    ).toBe(false);
    expect(watch.done({ ...world, barsHeard: WATCH_BARS }, world, settings)).toBe(false);
    // Begun while the song was already playing, the four bars count from the step.
    const midSong = { ...playing, barsHeard: 10 };
    expect(watch.done(midSong, midSong, settings)).toBe(false);
    expect(watch.done({ ...midSong, barsHeard: 14 }, midSong, settings)).toBe(true);
    expect(
      watch.done({ ...midSong, barsHeard: 14, masterClips: 1 }, midSong, settings),
    ).toBe(false);
    // Begun mid-song after the master clipped, and played again from the
    // start (both counts start again): four clean bars of the new run do it.
    const clipped = { ...midSong, masterClips: 1 };
    expect(
      watch.done(
        { ...playing, barsHeard: WATCH_BARS, masterClips: 0 },
        clipped,
        settings,
      ),
    ).toBe(true);
    expect(
      watch.done({ ...playing, barsHeard: 12, masterClips: 0 }, clipped, settings),
    ).toBe(true);
    // Show me plays the drop, the loudest part.
    expect(watch.showMe(world, settings, lessonContext())).toEqual({
      kind: "play",
      from: 16 * TICKS_PER_BAR,
    });
  });

  it("opens the Export dialog as the last bite starts, and is done once stems are exported", () => {
    const world = partsWorld();
    const step = mix("mix-export").steps[0];
    expect(step.showsAtStart).toBe(true);
    expect(step.showMe(world, settings, lessonContext())).toEqual({ kind: "export" });
    expect(step.done(world, world, settings)).toBe(false);
    expect(step.done({ ...world, stemExports: 1 }, world, settings)).toBe(true);
    // Stems exported before the step began do not count.
    const earlier = { ...world, stemExports: 2 };
    expect(step.done(earlier, earlier, settings)).toBe(false);
  });
});
