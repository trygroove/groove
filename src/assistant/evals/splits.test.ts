import { describe, expect, it } from "vitest";
import {
  EVAL_CAPABILITIES,
  EVAL_CASES,
  parseJsonEvalCase,
  TYPESCRIPT_CASES,
} from "./cases";
import { HEAVY_OUTPUT_CASE_IDS } from "./sets";
import {
  caseSplit,
  caseSplitOrNull,
  casesInSplit,
  HELDOUT_CASE_IDS,
  TRAIN_CASE_IDS,
} from "./splits";

describe("the train and held-out split (GRV-110)", () => {
  it("gives every case a split, and names only cases that exist, each once", () => {
    for (const entry of EVAL_CASES) expect(caseSplitOrNull(entry)).not.toBeNull();
    const named = [...HELDOUT_CASE_IDS, ...TRAIN_CASE_IDS];
    expect(new Set(named).size).toBe(named.length);
    const ids = new Set(TYPESCRIPT_CASES.map((entry) => entry.id));
    expect(named.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("holds out a third of each capability, rounded, and about a third in all", () => {
    for (const capability of EVAL_CAPABILITIES) {
      const cases = EVAL_CASES.filter((entry) => entry.capability === capability);
      expect([capability, casesInSplit(cases, "heldout").length]).toEqual([
        capability,
        Math.round(cases.length / 3),
      ]);
    }
    const train = casesInSplit(EVAL_CASES, "train").length / EVAL_CASES.length;
    expect(train).toBeGreaterThan(0.55);
    expect(train).toBeLessThan(0.75);
  });

  it("leaves the heavy-output group cases on both sides, so its experiments have a gate", () => {
    const heavy = EVAL_CASES.filter((entry) =>
      (HEAVY_OUTPUT_CASE_IDS as readonly string[]).includes(entry.id),
    );
    expect(casesInSplit(heavy, "train").length).toBeGreaterThan(0);
    expect(casesInSplit(heavy, "heldout").length).toBeGreaterThan(0);
  });

  it("takes a case's own split first, and refuses a case with none", () => {
    expect(caseSplit({ id: "sketch-house" })).toBe("train");
    expect(caseSplit({ id: "sketch-broken" })).toBe("heldout");
    expect(caseSplit({ id: "sketch-house", split: "heldout" })).toBe("heldout");
    expect(() => caseSplit({ id: "saved-case" })).toThrow(/has no split/);
  });

  it("lets a JSON case name its split, and nothing else", () => {
    const json = {
      id: "saved-case",
      capability: "loopSketch",
      axis: "conventional",
      request: "Make a loop",
      expect: "proposal",
      fixture: "house-loop",
      selection: null,
      scope: {
        tracks: "all",
        createTracks: true,
        song: false,
        master: false,
        returns: false,
        sections: false,
      },
    };
    expect(parseJsonEvalCase({ ...json, split: "heldout" }, "case").split).toBe(
      "heldout",
    );
    expect(() => parseJsonEvalCase({ ...json, split: "test" }, "case")).toThrow(/split/);
  });
});
