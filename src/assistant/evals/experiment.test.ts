import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL,
  DEFAULT_GUARDRAILS,
  defineExperiment,
  ExperimentError,
  experimentIds,
  loadExperiment,
  validateExperiment,
} from "./experiment";
import { HEAVY_OUTPUT_CASE_IDS } from "./sets";
import { caseSplit } from "./splits";

const VALID = defineExperiment({
  id: "effort-low",
  card: "GRV-110",
  hypothesis: "Low effort writes fewer tokens.",
  variants: { low: { thinkingEffort: "low" } },
  goal: "outputTokens",
  cases: { set: "heavyOutput" },
});

function issues(raw: unknown): string {
  try {
    validateExperiment(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ExperimentError);
    return (error as Error).message;
  }
  throw new Error("expected the experiment to be refused");
}

describe("validateExperiment (GRV-110)", () => {
  it("resolves a valid experiment: the control first, the pool split, GRV-131's bar, 3 runs", () => {
    const experiment = validateExperiment(VALID);
    expect(experiment.variants).toEqual([
      { name: CONTROL, overrides: {} },
      { name: "low", overrides: { thinkingEffort: "low" } },
    ]);
    expect(experiment.guardrails).toEqual(DEFAULT_GUARDRAILS);
    expect(experiment.runs).toBe(3);
    const pool = [...experiment.train, ...experiment.heldout].map((entry) => entry.id);
    expect(pool.sort()).toEqual([...HEAVY_OUTPUT_CASE_IDS].sort());
    expect(experiment.train.every((entry) => caseSplit(entry) === "train")).toBe(true);
    expect(experiment.heldout.every((entry) => caseSplit(entry) === "heldout")).toBe(
      true,
    );
  });

  it("takes the full suite or a case list as its pool, and a tighter bar", () => {
    const all = validateExperiment({
      ...VALID,
      cases: "all",
      guardrails: { maxCheckDropPoints: 1 },
      runs: 2,
    });
    expect(all.train.length + all.heldout.length).toBeGreaterThan(50);
    expect(all.guardrails).toEqual({ maxCheckDropPoints: 1, maxOverallDropPoints: 2 });
    expect(all.runs).toBe(2);
    const listed = validateExperiment({
      ...VALID,
      cases: { caseIds: ["process-crushed", "process-glue"] },
    });
    expect(listed.train.map((entry) => entry.id)).toEqual(["process-crushed"]);
    expect(listed.heldout.map((entry) => entry.id)).toEqual(["process-glue"]);
  });

  it("keeps only the values a variant sets away from the defaults", () => {
    const experiment = validateExperiment({
      ...VALID,
      variants: { high: { thinkingEffort: "high" } },
    });
    expect(experiment.variants[1].overrides).toEqual({ thinkingEffort: "high" });
  });

  it("refuses a field of the wrong shape", () => {
    expect(issues({ ...VALID, id: "Effort Low" })).toMatch(/id: lower-case words/);
    expect(issues({ ...VALID, card: "#110" })).toMatch(/card: a Linear card/);
    expect(issues({ ...VALID, hypothesis: "one\ntwo" })).toMatch(/hypothesis: one line/);
    expect(issues({ ...VALID, goal: "vibes" })).toMatch(/goal/);
    expect(issues({ ...VALID, cases: { set: "everything" } })).toMatch(/cases/);
    expect(issues({ ...VALID, runs: 0 })).toMatch(/runs/);
    expect(issues({ ...VALID, extra: true })).toMatch(/extra/);
  });

  it("refuses a looser bar than GRV-131's", () => {
    expect(issues({ ...VALID, guardrails: { maxCheckDropPoints: 5 } })).toMatch(
      /maxCheckDropPoints: may tighten the bar, never loosen it/,
    );
    expect(issues({ ...VALID, guardrails: { maxOverallDropPoints: 2.5 } })).toMatch(
      /maxOverallDropPoints: may tighten the bar, never loosen it/,
    );
  });

  it("refuses a tactic or value the registry does not know", () => {
    expect(issues({ ...VALID, variants: { terse: { terseNotes: "on" } } })).toMatch(
      /variants.terse: unknown tactic "terseNotes"/,
    );
    expect(issues({ ...VALID, variants: { max: { thinkingEffort: "max" } } })).toMatch(
      /variants.max.thinkingEffort: takes low \| medium \| high, not "max"/,
    );
  });

  it("refuses no variant, one named control, one that is the control, and two the same", () => {
    expect(issues({ ...VALID, variants: {} })).toMatch(/name at least one/);
    expect(
      issues({ ...VALID, variants: { control: { thinkingEffort: "low" } } }),
    ).toMatch(/"control" is production's defaults/);
    expect(
      issues({ ...VALID, variants: { same: { thinkingEffort: "medium" } } }),
    ).toMatch(/variants.same: sets every tactic to its default/);
    expect(
      issues({
        ...VALID,
        variants: { low: { thinkingEffort: "low" }, also: { thinkingEffort: "low" } },
      }),
    ).toMatch(/variants.also: sets the same values as low/);
  });

  it("refuses a case that does not exist, one named twice, and a pool missing a side", () => {
    expect(issues({ ...VALID, cases: { caseIds: ["no-such-case"] } })).toMatch(
      /no eval case "no-such-case"/,
    );
    expect(
      issues({
        ...VALID,
        cases: { caseIds: ["sketch-house", "sketch-house", "sketch-broken"] },
      }),
    ).toMatch(/"sketch-house" is named twice/);
    expect(issues({ ...VALID, cases: { caseIds: ["sketch-house"] } })).toMatch(
      /none of them is held out/,
    );
    expect(issues({ ...VALID, cases: { caseIds: ["sketch-broken"] } })).toMatch(
      /none of them is a train case/,
    );
  });

  it("takes a planted registry in place of the real one", () => {
    const experiment = validateExperiment(
      { ...VALID, variants: { terse: { terseNotes: "on" } } },
      {
        tactics: {
          terseNotes: {
            description: "Planted.",
            values: ["off", "on"],
            default: "off",
            alters: ["prompt"],
          },
        },
      },
    );
    expect(experiment.variants[1]).toEqual({
      name: "terse",
      overrides: { terseNotes: "on" },
    });
  });
});

describe("the experiment files (GRV-110)", () => {
  it("are every one valid, and named for their IDs", async () => {
    const ids = experimentIds();
    expect(ids).toContain("thinking-effort-low");
    for (const id of ids) {
      const experiment = await loadExperiment(id);
      expect(experiment.id).toBe(id);
    }
  });

  it("include GRV-110's own: thinkingEffort=low on the heavy set, for output tokens", async () => {
    const experiment = await loadExperiment("thinking-effort-low");
    expect(experiment.goal).toBe("outputTokens");
    expect(experiment.cases).toEqual({ set: "heavyOutput" });
    expect(experiment.variants.map((variant) => variant.overrides)).toEqual([
      {},
      { thinkingEffort: "low" },
    ]);
  });

  it("refuses a missing file, a file with no default export, and a misnamed one", async () => {
    // Inside the repository, where the test runner can load a module from.
    mkdirSync(resolve("tmp"), { recursive: true });
    const dir = mkdtempSync(join(resolve("tmp"), "experiments-"));
    writeFileSync(join(dir, "empty.ts"), "export const nothing = 1;\n");
    writeFileSync(join(dir, "misnamed.ts"), `export default ${JSON.stringify(VALID)};\n`);
    await expect(loadExperiment("missing", dir)).rejects.toThrow(
      /No experiment "missing".*Experiments: empty, misnamed/,
    );
    await expect(loadExperiment("empty", dir)).rejects.toThrow(/has no default export/);
    await expect(loadExperiment("misnamed", dir)).rejects.toThrow(
      /holds the experiment "effort-low"; name it effort-low.ts/,
    );
    await expect(loadExperiment("../escape", dir)).rejects.toThrow(/No experiment/);
    rmSync(dir, { recursive: true, force: true });
  });
});
