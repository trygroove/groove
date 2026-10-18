import { describe, expect, it } from "vitest";
import { EvalUsageError } from "./cli";
import { validateExperiment } from "./experiment";
import { parseExperimentArgs, resolveBudget } from "./experimentCli";

function options(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseExperimentArgs(argv, env);
  if (parsed.kind !== "run") throw new Error("expected run options");
  return parsed.options;
}

describe("parseExperimentArgs (GRV-110)", () => {
  it("leaves the budget to the experiment, and defaults to its runs, 10 in flight and production's turn limit", () => {
    expect(options(["thinking-effort-low"])).toEqual({
      id: "thinking-effort-low",
      budgetUsd: null,
      runs: null,
      model: "claude-sonnet-5",
      concurrency: 10,
      turnTimeoutMs: 540_000,
      out: null,
      noPost: false,
    });
  });

  it("reads every option", () => {
    expect(
      options([
        "x",
        "--budget",
        "7.5",
        "--runs",
        "2",
        "--model",
        "claude-haiku-4-5",
        "--concurrency",
        "4",
        "--timeout",
        "60",
        "--out",
        "tmp/x",
        "--no-post",
      ]),
    ).toEqual({
      id: "x",
      budgetUsd: 7.5,
      runs: 2,
      model: "claude-haiku-4-5",
      concurrency: 4,
      turnTimeoutMs: 60_000,
      out: "tmp/x",
      noPost: true,
    });
  });

  it("takes the workflow's inputs from the environment, a blank one as unset", () => {
    expect(
      options([], { EXPERIMENT_ID: "x", EXPERIMENT_BUDGET: "10", EXPERIMENT_RUNS: "" }),
    ).toMatchObject({ id: "x", budgetUsd: 10, runs: null });
    expect(options([], { EXPERIMENT_ID: "x", EXPERIMENT_RUNS: "5" }).runs).toBe(5);
    // The workflow's budget input left empty: not given, so the file's budget stands.
    expect(
      options([], { EXPERIMENT_ID: "x", EXPERIMENT_BUDGET: " " }).budgetUsd,
    ).toBeNull();
  });

  it("refuses no experiment, two, a bad number, an unknown model or option", () => {
    expect(() => options([])).toThrow(/Name the experiment/);
    expect(() => options(["a", "b"])).toThrow(/one experiment at a time/);
    expect(() => options(["x", "--budget", "0"])).toThrow("--budget must be more than 0");
    expect(() => options(["x", "--budget", "lots"])).toThrow(EvalUsageError);
    expect(() => options(["x", "--runs", "1.5"])).toThrow(
      "--runs must be a whole number",
    );
    expect(() => options(["x", "--model", "gpt"])).toThrow(/Unknown model "gpt"/);
    expect(() => options(["x", "--fast"])).toThrow("Unknown option --fast");
    expect(() => options(["x", "--budget"])).toThrow("--budget needs a value");
    expect(parseExperimentArgs(["--help"]).kind).toBe("help");
  });
});

describe("resolveBudget (GRV-110)", () => {
  const experiment = (budget?: number) =>
    validateExperiment({
      id: "big",
      card: "GRV-147",
      hypothesis: "A big one.",
      variants: { high: { thinkingEffort: "high" }, low: { thinkingEffort: "low" } },
      goal: "outputTokens",
      cases: { set: "heavyOutput" },
      ...(budget === undefined ? {} : { budget }),
    });

  it("runs an experiment with budget: 60 at $60 when the command gives none", () => {
    expect(resolveBudget(options(["big"]).budgetUsd, experiment(60))).toBe(60);
    expect(
      resolveBudget(
        options([], { EXPERIMENT_ID: "big", EXPERIMENT_BUDGET: "" }).budgetUsd,
        experiment(60),
      ),
    ).toBe(60);
  });

  it("lets the command's budget, or the workflow's input, override the file's", () => {
    expect(
      resolveBudget(options(["big", "--budget", "10"]).budgetUsd, experiment(60)),
    ).toBe(10);
    expect(
      resolveBudget(
        options([], { EXPERIMENT_ID: "big", EXPERIMENT_BUDGET: "80" }).budgetUsd,
        experiment(60),
      ),
    ).toBe(80);
  });

  it("falls back to $25 when neither says", () => {
    expect(resolveBudget(options(["big"]).budgetUsd, experiment())).toBe(25);
  });
});
