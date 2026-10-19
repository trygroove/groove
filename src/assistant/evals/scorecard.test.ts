import { describe, expect, it } from "vitest";
import { buildTestReport, testRecord } from "../../testing/evalRecords";
import { ASSISTANT_MODELS } from "../config";
import { describeTactics } from "../tactics";
import {
  compareHeavySets,
  compareScorecards,
  formatDelta,
  formatMetric,
  heavySetOf,
  percentile,
  SCORECARD_METRICS,
  scorecardOf,
  secondaryOf,
  turnCostUsd,
} from "./scorecard";
import {
  caseSecondaryLines,
  comparisonConsoleLines,
  comparisonLines,
  heavySetConsoleLines,
  heavySetLines,
} from "./scorecardMarkdown";

const sonnet = ASSISTANT_MODELS["claude-sonnet-5"];

describe("percentile", () => {
  it("is nearest-rank, and null over nothing", () => {
    const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile([], 50)).toBeNull();
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile(twenty, 50)).toBe(10);
  });
});

describe("the headline", () => {
  it("rates check 1, every check and check 8, with errored turns apart", () => {
    const report = buildTestReport([
      testRecord({ valid: "pass", outcome: "pass" }),
      testRecord({ valid: "pass", outcome: "fail" }),
      testRecord({ valid: "fail", outcome: "pass" }),
      testRecord({ errorCode: "provider_error" }),
    ]);
    const { headline } = report.scorecard;
    expect(headline.applies).toEqual({ pass: 2, judged: 3, rate: 2 / 3 });
    expect(headline.expectMatch).toEqual({ pass: 2, judged: 3, rate: 2 / 3 });
    expect(headline.overall).toEqual({ pass: 4, judged: 6, rate: 4 / 6 });
    expect(headline.turns).toBe(4);
    expect(headline.errored).toBe(1);
  });

  it("has no rate when nothing was judged", () => {
    const report = buildTestReport([testRecord({ errorCode: "eval_timeout" })]);
    expect(report.scorecard.headline.applies).toEqual({ pass: 0, judged: 0, rate: null });
  });
});

describe("the secondary numbers", () => {
  it("takes latency over replies only and first text over turns that streamed some", () => {
    const secondary = secondaryOf(
      [
        testRecord({ durationMs: 4_000, firstTextMs: 1_000 }),
        testRecord({ durationMs: 2_000, firstTextMs: null }),
        testRecord({
          durationMs: 540_000,
          errorCode: "eval_timeout",
          firstTextMs: 3_000,
        }),
      ],
      sonnet,
    );
    expect(secondary.latencyMs).toEqual({ count: 2, p50: 2_000, p95: 4_000 });
    expect(secondary.firstTextMs).toEqual({ count: 2, p50: 1_000, p95: 3_000 });
  });

  it("sums and averages tokens over the turns that recorded them", () => {
    const secondary = secondaryOf(
      [
        testRecord({
          usage: { inputTokens: 1_000, outputTokens: 200, cacheReadInputTokens: 500 },
        }),
        testRecord({
          usage: { inputTokens: 3_000, outputTokens: 400, cacheCreationInputTokens: 50 },
        }),
        testRecord({ usage: null }),
      ],
      sonnet,
    );
    expect(secondary.tokens).toEqual({
      turns: 2,
      input: 4_000,
      output: 600,
      cacheRead: 500,
      cacheWrite: 50,
    });
    expect(secondary.meanTokens).toEqual({
      input: 2_000,
      output: 300,
      cacheRead: 250,
      cacheWrite: 25,
    });
  });

  it("estimates cost from the model's price per million tokens", () => {
    // $2/M input, $10/M output, $2.50/M cache write, $0.20/M cache read.
    expect(
      turnCostUsd(sonnet, {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(3, 10);
    const secondary = secondaryOf(
      [
        testRecord({ usage: { inputTokens: 1_000, outputTokens: 100 } }),
        testRecord({
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 10_000 },
        }),
        testRecord({ usage: null }),
      ],
      sonnet,
    );
    // 0.002 + 0.001, and 0.002; over the two turns that recorded usage.
    expect(secondary.costUsd.total).toBeCloseTo(0.005, 10);
    expect(secondary.costUsd.perTurn).toBeCloseTo(0.0025, 10);
  });

  it("has no cost for a model it has no price for, or with no tokens recorded", () => {
    expect(secondaryOf([testRecord()], null).costUsd).toEqual({
      total: null,
      perTurn: null,
    });
    const none = secondaryOf([testRecord({ usage: null })], sonnet);
    expect(none.costUsd).toEqual({ total: null, perTurn: null });
    expect(none.meanTokens.input).toBeNull();
    expect(
      buildTestReport([testRecord()], "claude-retired-1").scorecard.secondary.costUsd
        .total,
    ).toBeNull();
  });

  it("mixes stop reasons, counting a reply cut off at max_tokens as such", () => {
    const secondary = secondaryOf(
      [
        testRecord({ stopReason: "tool_use" }),
        testRecord({ stopReason: "tool_use" }),
        testRecord({ stopReason: "refusal" }),
        testRecord({ errorCode: "reply_too_long" }),
        testRecord({ errorCode: "provider_error" }),
      ],
      sonnet,
    );
    expect(secondary.stopReasons).toEqual({
      tool_use: 2,
      refusal: 1,
      max_tokens: 1,
      errored: 1,
    });
    expect(secondary.maxTokensRate).toBeCloseTo(0.2, 10);
    expect(secondary.refusalRate).toBeCloseTo(0.2, 10);
  });

  it("is kept per case as well as for the run", () => {
    const report = buildTestReport([
      testRecord({ caseId: "a", durationMs: 1_000 }),
      testRecord({ caseId: "a", durationMs: 3_000 }),
      testRecord({ caseId: "b", durationMs: 9_000 }),
    ]);
    expect(Object.keys(report.scorecard.cases)).toEqual(["a", "b"]);
    expect(report.scorecard.cases.a.latencyMs).toEqual({
      count: 2,
      p50: 1_000,
      p95: 3_000,
    });
    expect(report.scorecard.cases.b.turns).toBe(1);
    expect(report.scorecard.secondary.latencyMs.p95).toBe(9_000);
  });

  it("scores each set apart, a record saved before sets as a musical one (GRV-119)", () => {
    const report = buildTestReport([
      testRecord({ caseId: "a", valid: "pass" }),
      testRecord({ caseId: "b", set: "musical", valid: "fail" }),
      testRecord({ caseId: "c", set: "basicActions", valid: "pass", outcome: "pass" }),
      testRecord({ caseId: "d", set: "basicActions", valid: "fail", outcome: "fail" }),
      testRecord({ caseId: "d", set: "basicActions", errorCode: "provider_error" }),
    ]);
    const sets = report.scorecard.sets ?? {};
    expect(Object.keys(sets)).toEqual(["musical", "basicActions"]);
    expect(sets.musical.cases).toBe(2);
    expect(sets.musical.headline.applies).toEqual({ pass: 1, judged: 2, rate: 0.5 });
    expect(sets.basicActions.cases).toBe(2);
    expect(sets.basicActions.headline.expectMatch).toEqual({
      pass: 1,
      judged: 2,
      rate: 0.5,
    });
    expect(sets.basicActions.headline.overall).toEqual({ pass: 2, judged: 4, rate: 0.5 });
    expect(sets.basicActions.headline).toMatchObject({ turns: 3, errored: 1 });
    // The run's headline is every set's together.
    expect(report.scorecard.headline.applies).toEqual({ pass: 2, judged: 4, rate: 0.5 });
  });

  it("scores an older record without usage or first text as n/a, never zero", () => {
    const { usage: _usage, firstTextMs: _first, ...older } = testRecord();
    const card = scorecardOf({
      model: sonnet.id,
      caseIds: ["case-a"],
      records: [older],
      summary: buildTestReport([older]).summary,
    });
    expect(card.secondary.firstTextMs.p50).toBeNull();
    expect(card.secondary.meanTokens.output).toBeNull();
    expect(card.secondary.costUsd.perTurn).toBeNull();
  });
});

describe("compareScorecards", () => {
  const baseline = buildTestReport([
    testRecord({ valid: "pass", durationMs: 10_000, usage: { outputTokens: 1_000 } }),
    testRecord({ valid: "fail", durationMs: 20_000, usage: { outputTokens: 1_000 } }),
  ]).scorecard;
  const current = buildTestReport([
    testRecord({ valid: "pass", durationMs: 12_000, usage: { outputTokens: 500 } }),
    testRecord({ valid: "pass", durationMs: 30_000, usage: { outputTokens: 500 } }),
  ]).scorecard;
  const rows = compareScorecards(current, baseline);
  const row = (label: string) => rows.find((entry) => entry.label === label);

  it("sets every metric beside the baseline's", () => {
    expect(rows.map((entry) => entry.label)).toEqual(
      SCORECARD_METRICS.map((metric) => metric.label),
    );
  });

  it("gives each delta and whether it climbed or regressed", () => {
    expect(row("Applies cleanly (check 1)")).toMatchObject({
      current: 1,
      baseline: 0.5,
      delta: 0.5,
      verdict: "better",
    });
    expect(row("Latency p95")).toMatchObject({
      current: 30_000,
      baseline: 20_000,
      delta: 10_000,
      verdict: "worse",
    });
    expect(row("Output tokens per turn")).toMatchObject({
      delta: -500,
      verdict: "better",
    });
    // 500 fewer output tokens at $10/M is $0.005 a turn cheaper.
    expect(row("Cost per turn")?.delta).toBeCloseTo(-0.005, 10);
    expect(row("Cost per turn")?.verdict).toBe("better");
    expect(row("Errored turns")).toMatchObject({ delta: 0, verdict: "same" });
  });

  it("compares a two-set run with a musical-only baseline set by set (GRV-119)", () => {
    const twoSets = buildTestReport([
      testRecord({ caseId: "m", set: "musical", valid: "pass", durationMs: 10_000 }),
      testRecord({ caseId: "m", set: "musical", valid: "fail", durationMs: 20_000 }),
      testRecord({ caseId: "b", set: "basicActions", valid: "pass", durationMs: 1_000 }),
      testRecord({ caseId: "b", set: "basicActions", valid: "pass", durationMs: 1_000 }),
    ]).scorecard;
    // A baseline saved before sets: its whole scorecard, with no `sets`.
    const { sets: _sets, ...musicalOnly } = baseline;
    const compared = compareScorecards(twoSets, musicalOnly);
    const of = (set: string, label: string) =>
      compared.find((entry) => entry.set === set && entry.label === label);
    // The musical cases against the musical baseline: 50% then and now, not
    // the run's 75% (which counts the basic actions in).
    expect(twoSets.headline.applies.rate).toBe(0.75);
    expect(of("musical", "Applies cleanly (check 1)")).toMatchObject({
      current: 0.5,
      baseline: 0.5,
      verdict: "same",
    });
    expect(of("musical", "Latency p95")).toMatchObject({
      current: 20_000,
      baseline: 20_000,
    });
    // The basic actions have no baseline to compare with.
    expect(of("basicActions", "Applies cleanly (check 1)")).toMatchObject({
      current: 1,
      baseline: null,
      verdict: "n/a",
    });
    // The report shows each set's rows under its own heading.
    const lines = comparisonLines(compared, {
      path: "baseline.json",
      generatedAt: "then",
      model: "m",
      promptVersion: "p",
      tactics: { thinkingEffort: "low" },
    });
    expect(lines).toContain("### Musical capability");
    expect(lines.join("\n")).toContain(
      `tactics ${describeTactics({ thinkingEffort: "low" })}`,
    );
    expect(lines).toContain("### Basic production actions");
    expect(comparisonConsoleLines(compared)).toContain("  Basic production actions:");
    // A baseline with sets is compared set by set as well.
    expect(
      compareScorecards(twoSets, twoSets).every(
        (entry) => entry.verdict === "same" || entry.verdict === "n/a",
      ),
    ).toBe(true);
    expect(
      compareScorecards(twoSets, twoSets).find(
        (entry) => entry.set === "basicActions" && entry.label === "Latency p95",
      )?.baseline,
    ).toBe(1_000);
  });

  it("says n/a where either side has no number", () => {
    const older = buildTestReport([
      testRecord({ usage: null, firstTextMs: null }),
    ]).scorecard;
    expect(
      compareScorecards(current, older).find((entry) => entry.label === "Cost per turn"),
    ).toMatchObject({ baseline: null, delta: null, verdict: "n/a" });
  });
});

describe("the heavy set (GRV-131)", () => {
  const heavyRun = buildTestReport([
    // sketch-house: 2,000 and 4,000 output tokens, so 3,000 a turn; p50 10 s.
    // Its model calls: 2 and 6, so a mean of 4 and a p95 of 6.
    testRecord({
      caseId: "sketch-house",
      durationMs: 10_000,
      usage: { outputTokens: 2_000 },
      modelCalls: 2,
    }),
    testRecord({
      caseId: "sketch-house",
      durationMs: 30_000,
      usage: { outputTokens: 4_000 },
      modelCalls: 6,
    }),
    // density-hats: one turn of 1,000 tokens in 50 s, in 1 call.
    testRecord({
      caseId: "density-hats",
      durationMs: 50_000,
      usage: { outputTokens: 1_000 },
      modelCalls: 1,
    }),
    // Not a heavy case: left out of the heavy set.
    testRecord({ caseId: "mute", durationMs: 1_000, usage: { outputTokens: 10 } }),
  ]).scorecard;

  it("averages each heavy case's own figure, every case weighing the same", () => {
    const heavy = heavySetOf(heavyRun);
    expect(heavy?.caseIds).toEqual(["sketch-house", "density-hats"]);
    // (3,000 + 1,000) / 2, not (2,000 + 4,000 + 1,000) / 3.
    expect(heavy?.outputTokens).toBe(2_000);
    expect(heavy?.latencyP50Ms).toBe(30_000);
    const perTurn = (id: string) => heavyRun.cases[id].costUsd.perTurn ?? 0;
    expect(heavy?.costPerTurnUsd).toBeCloseTo(
      (perTurn("sketch-house") + perTurn("density-hats")) / 2,
      12,
    );
    // Model calls per turn (GRV-142): (4 + 1) / 2 and (6 + 1) / 2.
    expect(heavyRun.cases["sketch-house"].modelCalls).toEqual({
      count: 2,
      mean: 4,
      p95: 6,
    });
    expect(heavy?.modelCallsMean).toBe(2.5);
    expect(heavy?.modelCallsP95).toBe(3.5);
  });

  it("leaves model calls n/a for turns that recorded none", () => {
    const older = buildTestReport([testRecord({ caseId: "sketch-house" })]).scorecard;
    expect(older.cases["sketch-house"].modelCalls).toEqual({
      count: 0,
      mean: null,
      p95: null,
    });
    expect(heavySetOf(older)?.modelCallsMean).toBeNull();
    expect(heavySetLines(older)).toContain("| Mean model calls per turn | n/a |");
  });

  it("is absent from a run with no heavy case", () => {
    const light = buildTestReport([testRecord({ caseId: "mute" })]).scorecard;
    expect(heavySetOf(light)).toBeNull();
    expect(heavySetLines(light)).toEqual([]);
    expect(compareHeavySets(light, heavyRun)).toBeNull();
  });

  it("compares with the baseline over the heavy cases this run has", () => {
    const now = buildTestReport([
      testRecord({
        caseId: "sketch-house",
        durationMs: 5_000,
        usage: { outputTokens: 1_500 },
      }),
    ]).scorecard;
    const rows = compareHeavySets(now, heavyRun) ?? [];
    expect(rows.map((row) => row.label)).toEqual([
      "Mean output tokens per turn",
      "Mean latency p50",
      "Mean cost per turn",
      "Mean model calls per turn",
      "Mean model calls p95",
    ]);
    // Against the baseline's sketch-house alone, not its density-hats too.
    expect(rows[0]).toMatchObject({
      current: 1_500,
      baseline: 3_000,
      delta: -1_500,
      verdict: "better",
    });
    expect(rows[1]).toMatchObject({ current: 5_000, baseline: 10_000 });
    const lines = heavySetLines(now, rows);
    expect(lines[0]).toBe("## Heavy set");
    expect(lines).toContain(
      "| Mean output tokens per turn | 1,500 | 3,000 | -1,500 | better |",
    );
    expect(heavySetConsoleLines(rows)[0]).toBe("  Heavy set:");
  });

  it("prints its numbers alone without a baseline", () => {
    expect(heavySetLines(heavyRun)).toContain("| Mean output tokens per turn | 2,000 |");
    expect(heavySetLines(heavyRun)).toContain("| Mean latency p50 | 30.0 s |");
    expect(heavySetLines(heavyRun)).toContain("| Mean model calls per turn | 2.5 |");
    expect(heavySetLines(heavyRun)).toContain("| Mean model calls p95 | 3.5 |");
  });

  it("reports each case's model calls per turn, mean and p95 (GRV-142)", () => {
    const lines = caseSecondaryLines(heavyRun);
    expect(lines[2]).toContain("| Model calls mean / p95 |");
    expect(lines.find((line) => line.startsWith("| `sketch-house` |"))).toContain(
      "| 4.0 / 6.0 |",
    );
    expect(lines.find((line) => line.startsWith("| `mute` |"))).toContain(
      "| n/a / n/a |",
    );
  });

  it("reads n/a for a baseline with none of this run's heavy cases", () => {
    const other = buildTestReport([testRecord({ caseId: "mute" })]).scorecard;
    const rows = compareHeavySets(heavyRun, other) ?? [];
    expect(rows.every((row) => row.verdict === "n/a" && row.baseline === null)).toBe(
      true,
    );
  });
});

describe("formatting", () => {
  it("prints each kind of number and its delta", () => {
    expect(formatMetric("rate", 0.725)).toBe("72.5%");
    expect(formatMetric("ms", 4_321)).toBe("4.3 s");
    expect(formatMetric("tokens", 1_204.4)).toBe("1,204");
    expect(formatMetric("usd", 0.01234)).toBe("$0.0123");
    expect(formatMetric("count", 3)).toBe("3");
    expect(formatMetric("rate", null)).toBe("n/a");
    expect(formatDelta("rate", 0.025)).toBe("+2.5 pp");
    expect(formatDelta("ms", -1_200)).toBe("-1.2 s");
    expect(formatDelta("tokens", 310)).toBe("+310");
    expect(formatDelta("usd", -0.004)).toBe("-$0.0040");
    expect(formatDelta("count", 0)).toBe("±0");
    expect(formatDelta("usd", null)).toBe("n/a");
  });
});
