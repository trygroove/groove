import { describe, expect, it } from "vitest";
import { EvalUsageError } from "./cli";
import { parseExperimentArgs } from "./experimentCli";

function options(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseExperimentArgs(argv, env);
  if (parsed.kind !== "run") throw new Error("expected run options");
  return parsed.options;
}

describe("parseExperimentArgs (GRV-110)", () => {
  it("defaults to a $25 budget, the experiment's runs, 10 in flight and production's turn limit", () => {
    expect(options(["thinking-effort-low"])).toEqual({
      id: "thinking-effort-low",
      budgetUsd: 25,
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
