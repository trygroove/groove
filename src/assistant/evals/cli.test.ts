import { describe, expect, it } from "vitest";
import { buildTestReport, testRecord } from "../../testing/evalRecords";
import { ASSISTANT_MODEL_ID } from "../config";
import { EVAL_CASES } from "./cases";
import {
  EvalUsageError,
  loadBaseline,
  parseEvalArgs,
  requireApiKey,
  selectEvalCases,
} from "./cli";
import { summaryOf } from "./run";
import { HEAVY_OUTPUT_CASE_IDS } from "./sets";

function options(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseEvalArgs(argv, env);
  if (parsed.kind !== "run") throw new Error("expected run options");
  return parsed.options;
}

describe("parseEvalArgs", () => {
  it("defaults to every case, 3 runs, the configured model and production's 540 s turn limit", () => {
    expect(options([])).toEqual({
      caseIds: [],
      set: null,
      runs: 3,
      model: ASSISTANT_MODEL_ID,
      out: null,
      replay: null,
      baseline: null,
      fromTranscript: null,
      concurrency: 3,
      turnTimeoutMs: 540_000,
      maxSteps: null,
    });
  });

  it("takes the most steps a turn may take, 1 for a turn of one call", () => {
    expect(options(["--steps", "1"]).maxSteps).toBe(1);
    expect(() => options(["--steps", "0"])).toThrow("--steps must be a whole number");
  });

  it("reads a transcript case file, alone (GRV-98)", () => {
    expect(options(["--from-transcript", "tmp/transcript-turn.json"])).toMatchObject({
      fromTranscript: "tmp/transcript-turn.json",
      caseIds: [],
    });
    expect(() => parseEvalArgs(["--from-transcript", "a.json", "sketch-house"])).toThrow(
      EvalUsageError,
    );
    expect(() =>
      parseEvalArgs(["--from-transcript", "a.json", "--replay", "r.json"]),
    ).toThrow(EvalUsageError);
    expect(() => parseEvalArgs(["--from-transcript"])).toThrow(EvalUsageError);
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
        "--baseline",
        "b.json",
      ]),
    ).toMatchObject({
      caseIds: ["process-glue", "sketch-house"],
      runs: 5,
      out: "tmp/x",
      concurrency: 2,
      turnTimeoutMs: 30_000,
      replay: "r.json",
      baseline: "b.json",
    });
  });

  it("reads the set to run", () => {
    expect(options(["--set", "basicActions"]).set).toBe("basicActions");
    expect(options(["--set", "heavyOutput"]).set).toBe("heavyOutput");
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
    [["--set", "vibes"], 'Unknown set "vibes". Sets: musical, basicActions, heavyOutput'],
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

  it("keeps to one set when given one (GRV-119)", () => {
    const basic = selectEvalCases([], EVAL_CASES, "basicActions");
    expect(basic).toHaveLength(32);
    expect(basic.every((entry) => entry.set === "basicActions")).toBe(true);
    const musical = selectEvalCases([], EVAL_CASES, "musical");
    expect(musical.length + basic.length).toBe(EVAL_CASES.length);
    expect(() => selectEvalCases(["sketch-house"], EVAL_CASES, "basicActions")).toThrow(
      'No eval case "sketch-house"',
    );
  });

  it("runs the heavy-output group's eight cases, each a real one (GRV-131)", () => {
    const heavy = selectEvalCases([], EVAL_CASES, "heavyOutput");
    expect(heavy.map((entry) => entry.id).sort()).toEqual(
      [...HEAVY_OUTPUT_CASE_IDS].sort(),
    );
    expect(heavy).toHaveLength(8);
    expect(selectEvalCases(["density-hats"], EVAL_CASES, "heavyOutput")).toHaveLength(1);
    expect(() => selectEvalCases(["basic-mute-hats"], EVAL_CASES, "heavyOutput")).toThrow(
      'No eval case "basic-mute-hats"',
    );
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

describe("loadBaseline", () => {
  const report = buildTestReport([
    testRecord({ caseId: "a", durationMs: 1_000 }),
    testRecord({ caseId: "a", durationMs: 3_000, valid: "fail" }),
  ]);

  it("scores a full report.json afresh from its records", () => {
    const saved = JSON.parse(JSON.stringify(report));
    delete saved.scorecard;
    const loaded = loadBaseline(saved, "r.json");
    expect(loaded.scorecard).toEqual(report.scorecard);
    expect(loaded.label).toEqual({
      path: "r.json",
      generatedAt: report.generatedAt,
      model: report.model,
      promptVersion: report.promptVersion,
    });
  });

  it("takes a summary.json's scorecard as it is", () => {
    const saved = JSON.parse(JSON.stringify(summaryOf(report)));
    expect(loadBaseline(saved, "s.json").scorecard).toEqual(report.scorecard);
  });

  it("refuses a file that is not a report", () => {
    expect(() => loadBaseline({ hello: 1 }, "x.json")).toThrow(EvalUsageError);
    expect(() => loadBaseline({ model: "m", summary: { checks: {} } }, "y.json")).toThrow(
      /neither records nor a scorecard/,
    );
  });
});
