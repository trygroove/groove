import { describe, expect, it } from "vitest";
import { CLOSING_WORDS, generateProjectName, LEAD_WORDS } from "./projectName";

/** A random source that replays `values` in order. */
function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++ % values.length];
}

describe("generateProjectName", () => {
  it("joins a lead word and a closing word", () => {
    expect(generateProjectName(sequence(0, 0))).toBe(
      `${LEAD_WORDS[0]} ${CLOSING_WORDS[0]}`,
    );
    expect(generateProjectName(sequence(0.9999, 0.9999))).toBe(
      `${LEAD_WORDS.at(-1)} ${CLOSING_WORDS.at(-1)}`,
    );
  });

  it("never repeats a word, as in 'Groove Groove'", () => {
    const lead = LEAD_WORDS.indexOf("Groove") / LEAD_WORDS.length;
    const closer = CLOSING_WORDS.indexOf("Groove") / CLOSING_WORDS.length;
    expect(generateProjectName(sequence(lead, closer))).not.toBe("Groove Groove");
  });

  it("always yields two title-case words that fit a display name", () => {
    for (let i = 0; i < 500; i++) {
      const name = generateProjectName();
      const [lead, closer, ...rest] = name.split(" ");
      expect(rest).toEqual([]);
      expect(LEAD_WORDS).toContain(lead);
      expect(CLOSING_WORDS).toContain(closer);
      expect(lead).not.toBe(closer);
      expect(name.length).toBeLessThanOrEqual(120);
    }
  });

  it("has no duplicate words in either list", () => {
    expect(new Set(LEAD_WORDS).size).toBe(LEAD_WORDS.length);
    expect(new Set(CLOSING_WORDS).size).toBe(CLOSING_WORDS.length);
    for (const word of [...LEAD_WORDS, ...CLOSING_WORDS]) {
      expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});
