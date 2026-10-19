import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSISTANT_PROMPT_VERSION } from "../prompt";
import { TACTIC_DEFAULTS, TACTICS } from "../tactics";
import { ASSISTANT_TOOLSET_VERSION } from "../tools";
import {
  bumpPromptVersion,
  bumpToolsetVersion,
  cardStateAfter,
  PROMPT_PATH,
  setTacticDefault,
  TACTICS_PATH,
  TOOLS_PATH,
} from "./experimentPr";

describe("a win's file changes (GRV-110)", () => {
  it("moves one tactic's default line in the real registry and nothing else", () => {
    const source = readFileSync(TACTICS_PATH, "utf8");
    // Whichever effort production uses now, and one it does not.
    const DEFAULT = TACTIC_DEFAULTS.thinkingEffort;
    const OFF = TACTICS.thinkingEffort.values.find(
      (value) => value !== DEFAULT,
    ) as string;
    const changed = setTacticDefault(source, "thinkingEffort", OFF);
    const before = source.split("\n");
    const after = changed.split("\n");
    expect(after).toHaveLength(before.length);
    const moved = after.flatMap((line, index) =>
      line === before[index] ? [] : [[before[index], line]],
    );
    expect(moved).toEqual([[`    default: "${DEFAULT}",`, `    default: "${OFF}",`]]);
  });

  it("refuses a tactic the source has no entry or default line for", () => {
    expect(() =>
      setTacticDefault("export const TACTICS = {};\n", "thinkingEffort", "low"),
    ).toThrow(/no entry for the tactic thinkingEffort/);
    expect(() =>
      setTacticDefault(
        "const T = {\n  terse: {\n    values: [],\n  },\n};\n",
        "terse",
        "on",
      ),
    ).toThrow(/has no default/);
  });

  it("bumps the real prompt version: the next number today, or today's first", () => {
    const source = readFileSync(PROMPT_PATH, "utf8");
    const [day, number] = ASSISTANT_PROMPT_VERSION.split(".");
    expect(bumpPromptVersion(source, day)).toContain(
      `export const ASSISTANT_PROMPT_VERSION = "${day}.${Number(number) + 1}";`,
    );
    expect(bumpPromptVersion(source, "2099-01-02")).toContain(
      'export const ASSISTANT_PROMPT_VERSION = "2099-01-02.1";',
    );
    expect(() => bumpPromptVersion("", day)).toThrow(/no ASSISTANT_PROMPT_VERSION/);
  });

  it("bumps the real tool set version by one", () => {
    const source = readFileSync(TOOLS_PATH, "utf8");
    expect(bumpToolsetVersion(source)).toContain(
      `export const ASSISTANT_TOOLSET_VERSION = ${ASSISTANT_TOOLSET_VERSION + 1};`,
    );
    expect(() => bumpToolsetVersion("")).toThrow(/no ASSISTANT_TOOLSET_VERSION/);
  });
});

describe("where the verdict leaves the card", () => {
  it("waits a win on its held PR, finishes no win, and blocks everything else", () => {
    expect(cardStateAfter("win", "https://github.com/trygroove/groove/pull/1")).toBe(
      "Ready For Review",
    );
    expect(cardStateAfter("no win", null)).toBe("Done");
    expect(cardStateAfter("inconclusive", null)).toBe("Blocked");
    // A win whose PR did not open has nothing to review.
    expect(cardStateAfter("win", null)).toBe("Blocked");
  });
});
