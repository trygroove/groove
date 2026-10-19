import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TACTIC_DEFAULTS, TACTICS, type TacticOverrides } from "../tactics";
import { EVAL_CASES } from "./cases";
import {
  assertRunnable,
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

/**
 * Production's current effort, and two that are not it. Read from the
 * registry, never written out, so a win PR flipping the default leaves these
 * tests standing.
 */
const DEFAULT = TACTIC_DEFAULTS.thinkingEffort;
const [OFF, OTHER] = TACTICS.thinkingEffort.values.filter((value) => value !== DEFAULT);
const off = { thinkingEffort: OFF } as TacticOverrides;
const other = { thinkingEffort: OTHER } as TacticOverrides;

const VALID = defineExperiment({
  id: "effort-off",
  card: "GRV-110",
  hypothesis: "Another effort writes fewer tokens.",
  variants: { off },
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
      { name: CONTROL, overrides: {}, kind: "improve" },
      { name: "off", overrides: off, kind: "improve" },
    ]);
    expect(experiment.guardrails).toEqual(DEFAULT_GUARDRAILS);
    expect(experiment.runs).toBe(3);
    expect(experiment.budgetUsd).toBeNull();
    expect(experiment.atDefaults).toEqual([]);
    const pool = [...experiment.train, ...experiment.heldout].map((entry) => entry.id);
    expect(pool.sort()).toEqual([...HEAVY_OUTPUT_CASE_IDS].sort());
    expect(experiment.train.every((entry) => caseSplit(entry) === "train")).toBe(true);
    expect(experiment.heldout.every((entry) => caseSplit(entry) === "heldout")).toBe(
      true,
    );
  });

  // GRV-145: a focus within the pool, and the stricter guardrails.
  it("takes a focus within the pool and the stricter guardrails, and refuses a focus outside it", () => {
    const focused = validateExperiment({
      ...VALID,
      focus: ["sketch-house", "sketch-broken"],
      guardrails: { noMaxTokens: true, everyTurnChecks: ["noEmptyClips"] },
    });
    expect(focused.focus).toEqual(["sketch-house", "sketch-broken"]);
    expect(focused.guardrails.noMaxTokens).toBe(true);
    expect(focused.guardrails.everyTurnChecks).toEqual(["noEmptyClips"]);
    expect(validateExperiment(VALID).focus).toBeNull();
    expect(issues({ ...VALID, focus: ["basic-tempo"] })).toMatch(
      /focus: "basic-tempo" is not one of the cases/,
    );
    expect(issues({ ...VALID, focus: ["sketch-broken"] })).toMatch(
      /focus: none of them is a train case/,
    );
    expect(issues({ ...VALID, focus: ["sketch-house", "sketch-house"] })).toMatch(
      /focus: a case is named twice/,
    );
    expect(issues({ ...VALID, focus: [] })).toMatch(/focus/);
    expect(
      issues({ ...VALID, guardrails: { everyTurnChecks: ["noSuchCheck"] } }),
    ).toMatch(/everyTurnChecks/);
    // A case check a session does not judge on each turn would pass unjudged.
    expect(
      issues({
        ...VALID,
        guardrails: { everyTurnChecks: ["noEmptyClips", "hatDensity"] },
      }),
    ).toMatch(
      /everyTurnChecks.*only a check judged on every turn: noEmptyClips, clipsPlaced/,
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
    expect(all.guardrails).toEqual({
      maxCheckDropPoints: 1,
      maxOverallDropPoints: 2,
      cutMarginPercent: 2,
      holdNotFlattened: false,
    });
    expect(all.runs).toBe(2);
    const listed = validateExperiment({
      ...VALID,
      cases: { caseIds: ["process-crushed", "process-glue"] },
    });
    expect(listed.train.map((entry) => entry.id)).toEqual(["process-crushed"]);
    expect(listed.heldout.map((entry) => entry.id)).toEqual(["process-glue"]);
  });

  it("keeps only the values a variant sets away from the defaults", () => {
    const experiment = validateExperiment({ ...VALID, variants: { other } });
    expect(experiment.variants[1].overrides).toEqual(other);
  });

  it("takes its own budget, a positive number of dollars", () => {
    expect(validateExperiment({ ...VALID, budget: 60 }).budgetUsd).toBe(60);
    expect(issues({ ...VALID, budget: 0 })).toMatch(/budget/);
    expect(issues({ ...VALID, budget: -5 })).toMatch(/budget/);
    expect(issues({ ...VALID, budget: "60" })).toMatch(/budget/);
  });

  it("takes a variant's kind, an improve unless it says it is a cut", () => {
    const experiment = validateExperiment({
      ...VALID,
      variants: {
        plain: off,
        spelled: { kind: "improve", tactics: other },
      },
    });
    expect(experiment.variants.map((variant) => [variant.name, variant.kind])).toEqual([
      [CONTROL, "improve"],
      ["plain", "improve"],
      ["spelled", "improve"],
    ]);
    const cut = validateExperiment({
      ...VALID,
      variants: { trim: { kind: "cut", tactics: off } },
    });
    expect(cut.variants[1]).toEqual({ name: "trim", overrides: off, kind: "cut" });
    expect(
      issues({ ...VALID, variants: { trim: { kind: "remove", tactics: off } } }),
    ).toMatch(/variants/);
  });

  it("refuses a cut that sets a tactic another variant sets, and the combined cuts' name", () => {
    expect(
      issues({
        ...VALID,
        variants: { trim: { kind: "cut", tactics: off }, keep: other },
      }),
    ).toMatch(/variants.trim: a cut sets thinkingEffort, which keep sets too/);
    expect(issues({ ...VALID, variants: { "combined-cuts": off } })).toMatch(
      /"combined-cuts" is the name the passing cuts rerun under/,
    );
  });

  it("refuses a looser cut margin than 2%", () => {
    expect(issues({ ...VALID, guardrails: { cutMarginPercent: 3 } })).toMatch(
      /cutMarginPercent: may tighten the bar, never loosen it/,
    );
    expect(
      validateExperiment({ ...VALID, guardrails: { cutMarginPercent: 1 } }).guardrails
        .cutMarginPercent,
    ).toBe(1);
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

  it("runs a check-6 block per split only when an experiment holds check 6 (GRV-141)", () => {
    const plain = validateExperiment(VALID);
    expect(plain.guardrails.holdNotFlattened).toBe(false);
    expect(plain.flattening).toEqual({ train: [], heldout: [] });
    const held = validateExperiment({ ...VALID, guardrails: { holdNotFlattened: true } });
    const ids = (cases: readonly { id: string }[]) => cases.map((entry) => entry.id);
    // Each split's extreme cases, each beside its conventional partner from the other split.
    expect(ids(held.flattening.train)).toEqual([
      "variation-mangled",
      "variation-fill",
      "process-crushed",
      "process-glue",
    ]);
    expect(ids(held.flattening.heldout)).toEqual([
      "sketch-broken",
      "sketch-house",
      "arrange-no-build",
      "arrange-build-drop",
      "balance-lopsided",
      "balance-clean",
    ]);
    // The pool itself is unchanged.
    expect(ids(held.train)).toEqual(ids(plain.train));
    expect(ids(held.heldout)).toEqual(ids(plain.heldout));
    // A suite with no pair in a split cannot judge it, so is refused.
    expect(() =>
      validateExperiment(
        { ...VALID, guardrails: { holdNotFlattened: true } },
        {
          cases: EVAL_CASES.filter(
            (entry) => !(entry.axis === "extreme" && caseSplit(entry) === "train"),
          ),
        },
      ),
    ).toThrow(/no extreme train case has a conventional partner/);
  });

  it("refuses a tactic or value the registry does not know", () => {
    expect(issues({ ...VALID, variants: { terse: { terseNotes: "on" } } })).toMatch(
      /variants.terse: unknown tactic "terseNotes"/,
    );
    expect(issues({ ...VALID, variants: { max: { thinkingEffort: "max" } } })).toMatch(
      /variants.max.thinkingEffort: takes low \| medium \| high, not "max"/,
    );
  });

  it("refuses no variant, one named control, one that sets nothing, and two the same", () => {
    expect(issues({ ...VALID, variants: {} })).toMatch(/name at least one/);
    expect(issues({ ...VALID, variants: { control: off } })).toMatch(
      /"control" is production's defaults/,
    );
    expect(issues({ ...VALID, variants: { none: {} } })).toMatch(
      /variants.none: sets no tactic, so it is the control/,
    );
    expect(issues({ ...VALID, variants: { off, also: off } })).toMatch(
      /variants.also: sets the same values as off/,
    );
  });

  it("sets aside, without refusing, a variant production's defaults already are, as after its own win", () => {
    const experiment = validateExperiment({
      ...VALID,
      variants: { same: { thinkingEffort: DEFAULT }, off },
    });
    expect(experiment.atDefaults).toEqual(["same"]);
    expect(experiment.variants.map((variant) => variant.name)).toEqual([CONTROL, "off"]);
    expect(() => assertRunnable(experiment)).not.toThrow();

    const won = validateExperiment({
      ...VALID,
      variants: { same: { thinkingEffort: DEFAULT } },
    });
    expect(won.variants.map((variant) => variant.name)).toEqual([CONTROL]);
    expect(() => assertRunnable(won)).toThrow(/has nothing to run.*`same`/);
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
      kind: "improve",
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

  it("include GRV-146's: toolText moderate and aggressive, for time to the first word", async () => {
    const experiment = await loadExperiment("tool-text");
    expect(experiment.goal).toBe("firstTextP50");
    expect(experiment.cases).toBe("all");
    expect([
      ...experiment.variants.slice(1).map((v) => v.name),
      ...experiment.atDefaults,
    ]).toEqual(["moderate", "aggressive"]);
  });

  it("include GRV-143's: toolBundles=bundled over the suite, for time to the first word", async () => {
    const written = (await import("../../../evals/experiments/tool-bundles")).default;
    expect(written.variants).toEqual({ bundled: { toolBundles: "bundled" } });
    const experiment = await loadExperiment("tool-bundles");
    expect(experiment.card).toBe("GRV-143");
    expect(experiment.goal).toBe("firstTextP50");
    expect(experiment.cases).toBe("all");
  });

  it("include GRV-110's own: thinkingEffort=low on the heavy set, for output tokens", async () => {
    const written = (await import("../../../evals/experiments/thinking-effort-low"))
      .default;
    expect(written.variants).toEqual({ low: { thinkingEffort: "low" } });
    const experiment = await loadExperiment("thinking-effort-low");
    expect(experiment.goal).toBe("outputTokens");
    expect(experiment.cases).toEqual({ set: "heavyOutput" });
    // Run against the control until a win makes low production's default.
    expect([
      ...experiment.variants.slice(1).map((v) => v.name),
      ...experiment.atDefaults,
    ]).toEqual(["low"]);
  });

  it("include GRV-142's: oneResponseProposal=on on the heavy set, for latency p50", async () => {
    const written = (await import("../../../evals/experiments/one-response-proposal"))
      .default;
    expect(written.variants).toEqual({ "one-response": { oneResponseProposal: "on" } });
    expect(written.guardrails).toBeUndefined();
    const experiment = await loadExperiment("one-response-proposal");
    expect(experiment.card).toBe("GRV-142");
    expect(experiment.goal).toBe("latencyP50");
    expect(experiment.cases).toEqual({ set: "heavyOutput" });
  });

  it("include GRV-145's: guidedBuild=on over the suite, for quality on its session cases", async () => {
    const written = (await import("../../../evals/experiments/guided-build")).default;
    expect(written.variants).toEqual({ guided: { guidedBuild: "on" } });
    const experiment = await loadExperiment("guided-build");
    expect(experiment.card).toBe("GRV-145");
    expect(experiment.goal).toBe("quality");
    expect(experiment.cases).toBe("all");
    expect(experiment.focus).toEqual([
      "develop-track-arrange",
      "full-track-empty",
      "full-tune-loop",
    ]);
    // Every focus case is a session, and trains: at least the 3 an interval needs.
    const focus = experiment.train.filter((entry) =>
      experiment.focus?.includes(entry.id),
    );
    expect(focus).toHaveLength(3);
    expect(focus.every((entry) => entry.session)).toBe(true);
    expect(experiment.guardrails).toEqual({
      ...DEFAULT_GUARDRAILS,
      noMaxTokens: true,
      outputTokensPerTurn: true,
      everyTurnChecks: ["noEmptyClips", "clipsPlaced"],
    });
    expect(experiment.budgetUsd).toBe(40);
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
      /holds the experiment "effort-off"; name it effort-off.ts/,
    );
    await expect(loadExperiment("../escape", dir)).rejects.toThrow(/No experiment/);
    rmSync(dir, { recursive: true, force: true });
  });
});
