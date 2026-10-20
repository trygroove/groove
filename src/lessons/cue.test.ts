import { describe, expect, it } from "vitest";
import { starterWorld } from "../testing/lessonWorld";
import { cueMessage, lessonCue, wrapUpPointers } from "./cue";
import { BITE_IDS } from "./ids";
import { skip, startBite } from "./session";

const settings = { style: "trap" } as const;

describe("what a lesson tells Coproducer (GRV-43)", () => {
  it("says which bite has started, its step in plain words and the beat it teaches", () => {
    const world = starterWorld();
    const { state, event } = startBite("beat", "beat-kick", world, settings);
    const cue = lessonCue(state, event, settings, []);
    expect(cue).toMatchObject({
      chapterId: "beat",
      chapter: "Make a beat",
      biteId: "beat-kick",
      bite: "The kick pattern",
      biteNumber: 2,
      biteCount: 6,
      moment: "bite_started",
      how: null,
      style: "trap",
      quiz: null,
      next: [],
      changes: [],
    });
    expect(cue.step).toMatch(/^Put the kick on beat 1/);
    expect(cue.step).not.toMatch(/\]\(/);
    expect(cueMessage(state, event)).toBe('Let\'s do "The kick pattern".');
  });

  it("gives the quiz and the next bite once a bite is over", () => {
    const world = starterWorld();
    const started = startBite("beat", "beat-play", world, settings).state;
    // Hear it sets the tempo first, then plays: skip both.
    const tempoSkipped = skip(started, world, settings);
    const ended = tempoSkipped && skip(tempoSkipped.state, world, settings);
    if (!ended) throw new Error("not skipped");
    const cue = lessonCue(ended.state, ended.event, settings, []);
    expect(cue.moment).toBe("bite_done");
    expect(cue.how).toBe("skipped");
    expect(cue.step).toBeNull();
    expect(cue.quiz).toMatch(/Space/);
    expect(cue.next).toEqual(["The backbeat"]);
    expect(cueMessage(ended.state, ended.event)).toBe('Skipped "Hear it".');
  });

  it("wraps a chapter up with pointers to what is left, and no style outside the beat", () => {
    const world = starterWorld();
    const started = startBite("tour", "tour-mixer", world, settings).state;
    const ended = skip(started, world, settings);
    if (!ended) throw new Error("not skipped");
    const cue = lessonCue(ended.state, ended.event, settings, ["tour-mixer"]);
    expect(cue.moment).toBe("chapter_done");
    expect(cue.style).toBeNull();
    expect(cue.next).toHaveLength(3);
    expect(cue.next[0]).toMatch(/^The "Make a beat" chapter/);
    expect(cueMessage(ended.state, ended.event)).toBe(
      'Skipped "The Mixer". That was the last bite of "Tour the studio".',
    );
    // Once every other chapter is done, only the chapter's own pointers are left.
    expect(wrapUpPointers("tour", [...BITE_IDS])).toEqual([
      "Ask Coproducer for a loop to start from",
    ]);
  });

  it("is under way for a turn the producer sends mid-lesson", () => {
    const world = starterWorld();
    const { state } = startBite("sound", null, world, settings);
    expect(lessonCue(state, null, settings, []).moment).toBe("under_way");
  });
});
