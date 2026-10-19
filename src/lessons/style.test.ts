import { describe, expect, it } from "vitest";
import { GENRE_CHOICES } from "../onboarding/questions";
import { isTermId } from "./glossary";
import { BEAT_PATTERNS, BEAT_STYLES, beatStyleFor, stepList } from "./style";

describe("the beat a producer learns (GRV-43)", () => {
  it("follows the genre they love: four on the floor, boom bap or trap", () => {
    expect(beatStyleFor(["House", "Techno"])).toBe("four_on_the_floor");
    expect(beatStyleFor(["Hip hop"])).toBe("boom_bap");
    expect(beatStyleFor(["Lo-fi"])).toBe("boom_bap");
    expect(beatStyleFor(["Trap", "House"])).toBe("trap");
    expect(beatStyleFor(["Ambient"])).toBe("four_on_the_floor");
    expect(beatStyleFor([])).toBe("four_on_the_floor");
    for (const genre of GENRE_CHOICES) {
      expect(BEAT_STYLES).toContain(beatStyleFor([genre]));
    }
  });

  it("keeps every pattern within one bar of sixteen steps, and names a term the glossary has", () => {
    for (const style of BEAT_STYLES) {
      const pattern = BEAT_PATTERNS[style];
      for (const step of [...pattern.kick, ...pattern.snare, ...pattern.hats]) {
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThan(16);
      }
      expect(isTermId(pattern.termId)).toBe(true);
    }
  });

  it("numbers steps from 1, as the step grid does", () => {
    expect(stepList([0, 10])).toBe("1 and 11");
    expect(stepList([0, 4, 8, 12])).toBe("1, 5, 9 and 13");
    expect(stepList([8])).toBe("9");
  });
});
