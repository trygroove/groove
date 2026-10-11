import { describe, expect, it } from "vitest";
import { ASSISTANT_MODEL_ID } from "../config";
import { EVAL_CASES } from "./cases";
import { EvalUsageError, parseEvalArgs, requireApiKey, selectEvalCases } from "./cli";

function options(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseEvalArgs(argv, env);
  if (parsed.kind !== "run") throw new Error("expected run options");
  return parsed.options;
}

describe("parseEvalArgs", () => {
  it("defaults to every case, 3 runs, the configured model and production's 540 s turn limit", () => {
    expect(options([])).toEqual({
      caseIds: [],
      runs: 3,
      model: ASSISTANT_MODEL_ID,
      out: null,
      replay: null,
      concurrency: 3,
      turnTimeoutMs: 540_000,
    });
  });

  it("reads cases and every option", () => {
    expect(
      options([
        "process-glue",
        "--runs",
        "5",
        "sketch-house",
        "--out",
        "tmp/x",
        "--concurrency",
        "2",
        "--timeout",
        "30",
        "--replay",
        "r.json",
      ]),
    ).toMatchObject({
      caseIds: ["process-glue", "sketch-house"],
      runs: 5,
      out: "tmp/x",
      concurrency: 2,
      turnTimeoutMs: 30_000,
      replay: "r.json",
    });
  });

  it("takes the run count from EVAL_RUNS unless --runs says otherwise", () => {
    expect(options([], { EVAL_RUNS: "7" }).runs).toBe(7);
    expect(options(["--runs", "2"], { EVAL_RUNS: "7" }).runs).toBe(2);
  });

  it("answers --help with the usage and the case list", () => {
    const parsed = parseEvalArgs(["--help"]);
    expect(parsed.kind).toBe("help");
    if (parsed.kind === "help") expect(parsed.text).toContain(EVAL_CASES[0].id);
  });

  it.each([
    [["--runs", "0"], "--runs must be a whole number of at least 1"],
    [["--runs", "1.5"], "--runs must be a whole number of at least 1"],
    [["--concurrency", "x"], "--concurrency must be a whole number of at least 1"],
    [["--timeout", "0"], "--timeout must be a whole number of at least 1"],
    [["--runs"], "--runs needs a value"],
    [["--wat"], "Unknown option --wat"],
    [["--model", "gpt-4"], 'Unknown model "gpt-4"'],
  ])("refuses %j", (argv, message) => {
    expect(() => parseEvalArgs(argv)).toThrow(EvalUsageError);
    expect(() => parseEvalArgs(argv)).toThrow(message);
  });
});

describe("selectEvalCases", () => {
  it("returns every case when none is named, else the named ones in order", () => {
    expect(selectEvalCases([])).toEqual(EVAL_CASES);
    const [first, second] = EVAL_CASES;
    expect(selectEvalCases([second.id, first.id])).toEqual([second, first]);
  });

  it("refuses an unknown case and lists the real ones", () => {
    expect(() => selectEvalCases(["nope"])).toThrow(/No eval case "nope"\. Cases: /);
  });
});

describe("requireApiKey", () => {
  it("returns the key from the environment", () => {
    expect(requireApiKey({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("sk-ant-x");
  });

  it.each([{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_API_KEY: "  " }])(
    "refuses a missing or empty key, saying no model was called (%j)",
    (env) => {
      expect(() => requireApiKey(env)).toThrow(EvalUsageError);
      expect(() => requireApiKey(env)).toThrow(
        /ANTHROPIC_API_KEY is not set.*No model was called\./s,
      );
    },
  );
});
