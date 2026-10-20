import { describe, expect, it } from "vitest";
import { PRODUCER_GOALS } from "../persistence/profileDocuments";
import { starterWorld } from "../testing/lessonWorld";
import {
  ALL_BITES,
  bite,
  bitesDoneIn,
  CHAPTERS,
  chapter,
  chapterForGoal,
  nextBite,
  nextStep,
  withBiteDone,
} from "./chapters";
import { BITE_IDS, CHAPTER_IDS } from "./ids";

describe("the chapters (GRV-43)", () => {
  it("are the three this issue ships, in order, and list every bite ID once", () => {
    expect(CHAPTERS.map((one) => one.title)).toEqual([
      "Make a beat",
      "Shape a sound",
      "Tour the studio",
    ]);
    expect(CHAPTERS.map((one) => one.id)).toEqual(CHAPTER_IDS);
    expect(ALL_BITES.map((one) => one.id)).toEqual(BITE_IDS);
    for (const one of ALL_BITES) {
      expect(chapter(one.chapter).bites).toContain(one);
      expect(bite(one.id)).toBe(one);
    }
  });

  it("gives every step an ID unique in its bite, and every bite a quiz", () => {
    for (const one of ALL_BITES) {
      const ids = one.steps.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(one.quiz).toMatch(/\?/);
    }
  });

  it("suggests a chapter for every goal", () => {
    expect(PRODUCER_GOALS.map(chapterForGoal)).toEqual(["beat", "beat", "sound", "tour"]);
    expect(chapterForGoal(null)).toBe("tour");
  });

  it("finds the next bite not done, from a chapter on and round to the first", () => {
    expect(nextBite([])?.id).toBe("beat-library");
    expect(nextBite(["beat-library", "beat-kick"])?.id).toBe("beat-play");
    expect(nextBite([], "tour")?.id).toBe("tour-arrangement");
    const tourDone = bitesDoneIn("tour", [...BITE_IDS]);
    expect(nextBite(tourDone, "tour")?.id).toBe("beat-library");
    expect(nextBite([...BITE_IDS])).toBeNull();
    // An ID the lessons no longer have does not count, and does not break it.
    expect(nextBite(["beat-gone"])?.id).toBe("beat-library");
  });

  it("records a bite as done once, as the latest", () => {
    expect(withBiteDone(["beat-kick", "beat-play"], "beat-kick")).toEqual([
      "beat-play",
      "beat-kick",
    ]);
    expect(bitesDoneIn("beat", ["tour-mixer", "beat-play", "beat-kick"])).toEqual([
      "beat-kick",
      "beat-play",
    ]);
  });

  it("passes over a step that does not apply", () => {
    const world = starterWorld();
    const settings = { style: "trap" } as const;
    // The starter has a drum machine, and its kick is not trap's yet.
    expect(nextStep(bite("beat-kick"), world, settings)?.step.id).toBe("pattern");
    expect(nextStep(bite("beat-kick"), world, settings, 2)).toBeNull();
    // Its four on the floor is house's, so a house producer clears it first.
    expect(
      nextStep(bite("beat-kick"), world, { style: "four_on_the_floor" })?.step.id,
    ).toBe("clear");
  });
});
