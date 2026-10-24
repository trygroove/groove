import { describe, expect, it } from "vitest";
import { startedAt, starterWorld } from "../testing/lessonWorld";
import { cueMessage, foldTurns, type LessonTurn, lessonCue, wrapUpPointers } from "./cue";
import { BITE_IDS, MAX_EARLIER } from "./ids";
import { type LessonTransition, skip, startNextBite } from "./session";

const settings = { style: "trap" } as const;

describe("what a lesson tells Coproducer (GRV-43)", () => {
  it("says which bite has started, its step in plain words and the beat it teaches", () => {
    const world = starterWorld();
    const { state, event } = startedAt("beat", "beat-kick", world, settings);
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
    const started = startedAt("beat", "beat-play", world, settings).state;
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
    const started = startedAt("tour", "tour-mixer", world, settings).state;
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
    // Once every other chapter is done, the goal's lesson and the chapter's
    // own pointers are left.
    expect(wrapUpPointers("tour", 0, [...BITE_IDS])).toEqual([
      'The "Make a beat" chapter: a one-bar beat, kick, backbeat and hats, looped for four bars',
      "Ask Coproducer for a loop to start from",
    ]);
  });

  it("points the tour's wrap-up first at the lesson the producer's goal suggests (GRV-190)", () => {
    expect(wrapUpPointers("tour", 0, [], "sound_design")[0]).toMatch(
      /^The "Shape a sound" chapter/,
    );
    expect(wrapUpPointers("tour", 0, [], "first_track")[0]).toMatch(
      /^The "Make a beat" chapter/,
    );
    expect(wrapUpPointers("tour", 0, [], "video_or_game")[0]).toMatch(
      /^The "Make a beat" chapter/,
    );
    const world = starterWorld();
    const started = startedAt("tour", "tour-mixer", world, settings).state;
    const ended = skip(started, world, { ...settings, goal: "sound_design" });
    if (!ended) throw new Error("not skipped");
    const cue = lessonCue(
      ended.state,
      ended.event,
      { ...settings, goal: "sound_design" },
      [],
    );
    expect(cue.next[0]).toMatch(/^The "Shape a sound" chapter/);
    // Pointers follow the list's order after it, and none comes twice.
    expect(new Set(cue.next).size).toBe(cue.next.length);
  });

  it("is under way for a turn the producer sends mid-lesson", () => {
    const world = starterWorld();
    const { state } = startedAt("sound", null, world, settings);
    expect(lessonCue(state, null, settings, []).moment).toBe("under_way");
  });
});

describe("turns that waited for a reply (GRV-43)", () => {
  const world = starterWorld();
  const turnOf = ({ state, event }: LessonTransition): LessonTurn => ({
    text: cueMessage(state, event),
    cue: lessonCue(state, event, settings, []),
  });
  /** Skips every step left in the bite, to its end. */
  function skipped(transition: LessonTransition): LessonTransition {
    let current = transition;
    do {
      const over = skip(current.state, world, settings);
      if (!over) throw new Error("not skipped");
      current = over;
    } while (current.event.kind !== "bite_done");
    return current;
  }

  it("goes as it is when it waited alone", () => {
    const one = turnOf(startedAt("beat", "beat-kick", world, settings));
    expect(foldTurns([one])).toBe(one);
  });

  it("carries a finished bite into the next bite's intro, so it is still celebrated", () => {
    const started = startedAt("beat", "beat-play", world, settings);
    const intro = turnOf(started);
    const finished = skipped(started);
    const next = startNextBite(finished.state, world, settings);
    if (!next) throw new Error("no next bite");
    const folded = foldTurns([intro, turnOf(finished), turnOf(next)]);
    expect(folded.cue).toMatchObject({ moment: "bite_started", biteId: "beat-snare" });
    // The old intro is stale once the producer moved on; the celebration is not.
    expect(folded.cue.earlier).toEqual([
      {
        moment: "bite_done",
        chapter: "Make a beat",
        bite: "Hear it",
        how: "skipped",
        changes: [],
      },
    ]);
    expect(folded.text).toBe('Skipped "Hear it". Let\'s do "The backbeat".');
  });

  it("keeps the intro of the bite still under way, and keeps at most a few moments", () => {
    const started = startedAt("beat", "beat-kick", world, settings);
    const intro = turnOf(started);
    const step = skip(started.state, world, settings);
    if (!step) throw new Error("not skipped");
    const folded = foldTurns([intro, turnOf(step)]);
    expect(folded.cue.earlier.map((one) => one.moment)).toEqual(["bite_started"]);

    const many = Array.from({ length: MAX_EARLIER + 3 }, () => turnOf(step));
    expect(foldTurns([intro, ...many]).cue.earlier).toHaveLength(MAX_EARLIER);
  });
});
