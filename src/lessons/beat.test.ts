import { describe, expect, it } from "vitest";
import { addNotes } from "../commands/definitions/notes";
import { setParameter } from "../commands/definitions/parameters";
import { addPlacement } from "../commands/definitions/placements";
import { removeTrack } from "../commands/definitions/tracks";
import { createNoteEvent, createPlacement } from "../domain/factories";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import {
  applied,
  applyShowMe,
  lessonContext,
  starterWorld,
} from "../testing/lessonWorld";
import { BEAT_CHAPTER, coveredTicks, LOOP_BARS, TEMPO_TOLERANCE } from "./beat";
import { nextStep } from "./chapters";
import { beatTrack, hitsAll, kickPad, stepsHit } from "./drums";
import { observe, startBite } from "./session";
import { BEAT_PATTERNS, BEAT_STYLES, type BeatStyle } from "./style";
import type { LessonBite, LessonStep, LessonWorld } from "./types";

const biteNamed = (id: string): LessonBite => {
  const found = BEAT_CHAPTER.bites.find((bite) => bite.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** The step a bite would run in `world`. */
function stepIn(
  id: string,
  world: LessonWorld,
  style: BeatStyle = "boom_bap",
): LessonStep {
  const next = nextStep(biteNamed(id), world, { style });
  if (!next) throw new Error(`${id} has no step`);
  return next.step;
}

function withKickAt(world: LessonWorld, steps: readonly number[]): LessonWorld {
  const track = beatTrack(world.project);
  const pad = track && kickPad(track);
  const clip = world.project.clips[0];
  if (!track || !pad || !clip) throw new Error("no beat");
  const context = lessonContext(7);
  return {
    ...world,
    project: applied(world.project, [
      addNotes(
        clip.id,
        steps.map((step) =>
          createNoteEvent(context, {
            startTicks: step * TICKS_PER_SIXTEENTH,
            durationTicks: TICKS_PER_SIXTEENTH,
            padId: pad.id,
          }),
        ),
      ),
    ]),
  };
}

describe("Make a beat (GRV-43)", () => {
  it("teaches six bites in order", () => {
    expect(BEAT_CHAPTER.bites.map((bite) => bite.title)).toEqual([
      "Pick a kick",
      "The kick pattern",
      "Hear it",
      "The backbeat",
      "Hats",
      "Loop it",
    ]);
  });

  describe("a song with no drum machine", () => {
    const empty = (): LessonWorld => {
      const world = starterWorld();
      const track = world.project.song.tracks[0];
      return { ...world, project: applied(world.project, [removeTrack(track.id)]) };
    };

    it("starts each bite by adding one, which Show me does", () => {
      const world = empty();
      const step = stepIn("beat-kick", world);
      expect(step.id).toBe("drums");
      expect(step.done(world, world, { style: "boom_bap" })).toBe(false);
      const after = applyShowMe(
        world,
        step.showMe(world, { style: "boom_bap" }, lessonContext()),
      );
      expect(step.done(after, world, { style: "boom_bap" })).toBe(true);
      expect(beatTrack(after.project)?.name).toBe("Drums");
      // The step is passed over once there is one.
      expect(stepIn("beat-kick", after).id).toBe("pattern");
    });
  });

  describe("Pick a kick", () => {
    it("is done once the kick pad plays another sound, and Show me asks the library for one", () => {
      const world = starterWorld();
      const step = stepIn("beat-library", world);
      expect(step.id).toBe("kick");
      expect(step.instruction(world, { style: "boom_bap" })).toMatch(/Library/);
      const track = beatTrack(world.project);
      const pad = track && kickPad(track);
      if (!track || !pad) throw new Error("no kick");
      expect(step.target(world, { style: "boom_bap" })).toEqual({
        entity: pad.id,
        param: "sample",
      });
      expect(step.showMe(world, { style: "boom_bap" }, lessonContext())).toEqual({
        kind: "sound",
        role: "kick",
        trackId: track.id,
        padId: pad.id,
      });
      expect(step.done(world, world, { style: "boom_bap" })).toBe(false);
      const swapped: LessonWorld = {
        ...world,
        project: {
          ...world.project,
          song: {
            ...world.project.song,
            tracks: world.project.song.tracks.map((one) =>
              one.instrument?.kind === "drumMachine"
                ? {
                    ...one,
                    instrument: {
                      ...one.instrument,
                      pads: one.instrument.pads.map((each) => ({
                        ...each,
                        assetId: "ast_other" as typeof each.assetId,
                      })),
                    },
                  }
                : one,
            ),
          },
        },
      };
      expect(step.done(swapped, world, { style: "boom_bap" })).toBe(true);
    });
  });

  describe("The kick pattern", () => {
    it.each(BEAT_STYLES)("asks for %s's kick in its own words", (style) => {
      const world = starterWorld();
      const words = stepIn("beat-kick", world, style).instruction(world, { style });
      expect(words).toContain(`(${BEAT_PATTERNS[style].termId})`);
    });

    /** The kick pad's steps in the beat's clip, in order. */
    const kickSteps = (world: LessonWorld): number[] => {
      const track = beatTrack(world.project);
      const pad = track && kickPad(track);
      if (!track || !pad) throw new Error("no kick");
      return [...stepsHit(world.project.clips[0], pad.id)].sort((a, b) => a - b);
    };

    it.each(BEAT_STYLES)(
      "on the starter project, is not done until %s's kick is the only kick, and Show me makes it so",
      (style) => {
        const settings = { style };
        const world = starterWorld();
        // The starter's kick: 1, 5, 9 and 13, four on the floor.
        expect(kickSteps(world)).toEqual([0, 4, 8, 12]);
        let state = startBite("beat", "beat-kick", world, settings).state;
        // Nothing is done as the bite starts, whatever the style.
        expect(observe(state, world, settings)).toBeNull();
        let now = world;
        if (style === "four_on_the_floor") {
          // The starter already plays it: the producer clears the row first.
          expect(biteNamed("beat-kick").steps[state.step?.index ?? -1]?.id).toBe("clear");
          const clear = stepIn("beat-kick", now, style);
          now = applyShowMe(now, clear.showMe(now, settings, lessonContext(1)));
          expect(kickSteps(now)).toEqual([]);
          const cleared = observe(state, now, settings);
          expect(cleared?.event).toMatchObject({ kind: "step_done", how: "did_it" });
          if (!cleared) throw new Error("not cleared");
          state = cleared.state;
          expect(observe(state, now, settings)).toBeNull();
        }
        const step = biteNamed("beat-kick").steps[state.step?.index ?? -1];
        expect(step?.id).toBe("pattern");
        if (!step) throw new Error("no pattern step");
        // The pattern's steps alone are not enough while other kicks stay.
        if (style !== "four_on_the_floor") {
          const withPattern = withKickAt(
            now,
            BEAT_PATTERNS[style].kick.filter((at) => at !== 0),
          );
          expect(step.done(withPattern, now, settings)).toBe(false);
        }
        const shown = applyShowMe(now, step.showMe(now, settings, lessonContext(2)));
        expect(kickSteps(shown)).toEqual(BEAT_PATTERNS[style].kick);
        expect(step.done(shown, now, settings)).toBe(true);
        expect(observe(state, shown, settings)?.event).toMatchObject({
          kind: "bite_done",
        });
      },
    );

    it("takes an off-grid kick for one off the pattern", () => {
      const world = starterWorld();
      const step = stepIn("beat-kick", world, "boom_bap");
      const track = beatTrack(world.project);
      const pad = track && kickPad(track);
      const clip = world.project.clips[0];
      if (!track || !pad || !clip) throw new Error("no beat");
      const exact = applyShowMe(
        world,
        step.showMe(world, { style: "boom_bap" }, lessonContext()),
      );
      expect(step.done(exact, world, { style: "boom_bap" })).toBe(true);
      const nudged = applied(exact.project, [
        addNotes(clip.id, [
          createNoteEvent(lessonContext(9), {
            startTicks: 5,
            durationTicks: TICKS_PER_SIXTEENTH,
            padId: pad.id,
          }),
        ]),
      ]);
      expect(step.done({ ...exact, project: nudged }, world, { style: "boom_bap" })).toBe(
        false,
      );
    });

    it.each(BEAT_STYLES)("Show me writes %s's kick into an empty clip", (style) => {
      const world = starterWorld();
      const blank: LessonWorld = {
        ...world,
        project: {
          ...world.project,
          clips: world.project.clips.map((clip) =>
            clip.content.kind === "notes"
              ? { ...clip, content: { ...clip.content, events: [] } }
              : clip,
          ),
        },
      };
      const step = stepIn("beat-kick", blank, style);
      expect(step.id).toBe("pattern");
      const after = applyShowMe(blank, step.showMe(blank, { style }, lessonContext()));
      expect(step.done(after, blank, { style })).toBe(true);
      expect(kickSteps(after)).toEqual(BEAT_PATTERNS[style].kick);
    });

    it("has nothing to show once the kick is the pattern", () => {
      const world = starterWorld();
      const pattern = biteNamed("beat-kick").steps.find((one) => one.id === "pattern");
      expect(
        pattern?.showMe(world, { style: "four_on_the_floor" }, lessonContext()),
      ).toBeNull();
    });
  });

  describe("Hear it", () => {
    it.each(BEAT_STYLES)(
      "first sets %s's tempo, which Show me sets on the song",
      (style) => {
        const settings = { style };
        const world = starterWorld();
        expect(world.project.song.tempo).toBe(120);
        const step = stepIn("beat-play", world, style);
        expect(step.id).toBe("tempo");
        expect(step.done(world, world, settings)).toBe(false);
        expect(step.target(world, settings)).toEqual({ entity: "song", param: "tempo" });
        const after = applyShowMe(world, step.showMe(world, settings, lessonContext()));
        expect(after.project.song.tempo).toBe(BEAT_PATTERNS[style].tempo);
        expect(step.done(after, world, settings)).toBe(true);
      },
    );

    it("holds near the style's tempo, not only on it, and is passed over once there", () => {
      const settings = { style: "boom_bap" } as const;
      const at = (tempo: number): LessonWorld => {
        const world = starterWorld();
        return {
          ...world,
          project: applied(world.project, [
            setParameter({ scope: "song", parameterId: "song.tempo" }, tempo),
          ]),
        };
      };
      const step = stepIn("beat-play", starterWorld(), "boom_bap");
      expect(step.done(at(90 + TEMPO_TOLERANCE), at(120), settings)).toBe(true);
      expect(step.done(at(90 - TEMPO_TOLERANCE), at(120), settings)).toBe(true);
      expect(step.done(at(90 + TEMPO_TOLERANCE + 1), at(120), settings)).toBe(false);
      expect(step.done(at(80), at(120), settings)).toBe(false);
      expect(stepIn("beat-play", at(91), "boom_bap").id).toBe("play");
    });

    it("is done while the song plays, and Show me plays it", () => {
      const world = starterWorld();
      const atTempo: LessonWorld = {
        ...world,
        project: applied(world.project, [
          setParameter({ scope: "song", parameterId: "song.tempo" }, 140),
        ]),
      };
      const step = stepIn("beat-play", atTempo, "trap");
      expect(step.id).toBe("play");
      expect(step.done(atTempo, atTempo, { style: "trap" })).toBe(false);
      expect(step.done({ ...atTempo, playing: true }, atTempo, { style: "trap" })).toBe(
        true,
      );
      expect(step.showMe(atTempo, { style: "trap" }, lessonContext())).toEqual({
        kind: "play",
      });
    });
  });

  describe.each([
    ["beat-snare", "snare", "Snare"],
    ["beat-hats", "hats", "Hat"],
  ] as const)("%s", (biteId, part, padName) => {
    it.each(BEAT_STYLES)("Show me adds a pad playing the %s part", (style) => {
      const world = starterWorld();
      const step = stepIn(biteId, world, style);
      expect(step.done(world, world, { style })).toBe(false);
      const after = applyShowMe(world, step.showMe(world, { style }, lessonContext()));
      expect(step.done(after, world, { style })).toBe(true);
      const track = beatTrack(after.project);
      if (!track) throw new Error("no beat");
      const name = style === "four_on_the_floor" && part === "snare" ? "Clap" : padName;
      const pad = track.instrument.pads.find((one) => one.name === name);
      expect(pad?.assetId).not.toBeNull();
      expect(
        hitsAll(
          after.project,
          track,
          pad?.id ?? ("" as never),
          BEAT_PATTERNS[style][part],
        ),
      ).toBe(true);
    });

    it("writes into a pad already named for the part rather than adding another", () => {
      const world = starterWorld();
      const step = stepIn(biteId, world, "boom_bap");
      const once = applyShowMe(
        world,
        step.showMe(world, { style: "boom_bap" }, lessonContext(1)),
      );
      const cleared: LessonWorld = {
        ...once,
        project: {
          ...once.project,
          clips: once.project.clips.map((clip) =>
            clip.content.kind === "notes"
              ? { ...clip, content: { ...clip.content, events: [] } }
              : clip,
          ),
        },
      };
      const twice = applyShowMe(
        cleared,
        step.showMe(cleared, { style: "boom_bap" }, lessonContext(2)),
      );
      const pads = beatTrack(twice.project)?.instrument.pads ?? [];
      expect(pads.filter((pad) => pad.name === padName)).toHaveLength(1);
      expect(step.done(twice, cleared, { style: "boom_bap" })).toBe(true);
    });
  });

  describe("Loop it", () => {
    it("is done once the beat plays for four bars, which Show me does by looping its clip", () => {
      const world = starterWorld();
      const step = stepIn("beat-loop", world);
      const track = beatTrack(world.project);
      if (!track) throw new Error("no beat");
      expect(step.done(world, world, { style: "trap" })).toBe(false);
      const after = applyShowMe(
        world,
        step.showMe(world, { style: "trap" }, lessonContext()),
      );
      expect(coveredTicks(after.project, track.id)).toBe(LOOP_BARS * TICKS_PER_BAR);
      expect(after.project.song.placements[0]?.looped).toBe(true);
      expect(step.done(after, world, { style: "trap" })).toBe(true);
    });

    it("has nothing to show when another clip sits in the way", () => {
      const world = starterWorld();
      const track = beatTrack(world.project);
      const clip = world.project.clips[0];
      if (!track || !clip) throw new Error("no beat");
      const crowded: LessonWorld = {
        ...world,
        project: applied(world.project, [
          addPlacement(
            createPlacement(lessonContext(), {
              clipId: clip.id,
              trackId: track.id,
              startTicks: 2 * TICKS_PER_BAR,
              durationTicks: TICKS_PER_BAR,
            }),
          ),
        ]),
      };
      expect(
        stepIn("beat-loop", crowded).showMe(crowded, { style: "trap" }, lessonContext()),
      ).toBeNull();
    });
  });
});
