import { describe, expect, it } from "vitest";
import {
  buildTestReport,
  type TestRecordOptions,
  testRecord,
} from "../../testing/evalRecords";
import { DEFAULT_GUARDRAILS, type ExperimentGuardrails } from "./experiment";
import type { EvalReport } from "./run";
import {
  analyzeCut,
  analyzeVariant,
  caseRegressions,
  checkGuardrails,
  judgeGoal,
  MIN_PAIRED_CASES,
} from "./verdict";

/** Three runs of each case, each run built by `run(caseId, index)`. */
function report(
  caseIds: readonly string[],
  run: (caseId: string, index: number) => TestRecordOptions = () => ({}),
  runs = 3,
): EvalReport {
  return buildTestReport(
    caseIds.flatMap((caseId) =>
      Array.from({ length: runs }, (_, index) =>
        testRecord({ caseId, run: index + 1, set: "musical", ...run(caseId, index) }),
      ),
    ),
  );
}

const CASES = ["case-a", "case-b", "case-c"];
const control = report(CASES);
const variant = { name: "terse", overrides: { terseNotes: "on" } };

function guardrail(id: string, current: EvalReport, limits = DEFAULT_GUARDRAILS) {
  return checkGuardrails(control, current, limits).find((entry) => entry.id === id);
}

describe("judgeGoal (GRV-110)", () => {
  it("pairs each case's figure and bootstraps the mean change", () => {
    const fewer = report(CASES, (caseId) => ({
      usage: { outputTokens: caseId === "case-a" ? 40 : 70 },
    }));
    const goal = judgeGoal("outputTokens", control, fewer);
    expect(goal).toMatchObject({
      control: 100,
      variant: 60,
      change: -40,
      pairedCases: 3,
      outcome: "better",
    });
    expect(goal.interval?.low).toBe(-60);
    expect(goal.interval?.high).toBe(-30);
  });

  it("reads quality as each case's pass rate, higher being better", () => {
    const worse = report(CASES, (caseId, index) => ({
      valid: caseId !== "case-c" && index === 0 ? "fail" : "pass",
    }));
    const goal = judgeGoal("quality", control, worse);
    expect(goal.higherIsBetter).toBe(true);
    expect(goal.change).toBeCloseTo(-1 / 9);
    // Two of three cases fell, one did not: the interval reaches zero.
    expect(goal.outcome).toBe("inconclusive");
  });

  it("is inconclusive on fewer than three paired cases, however clear the change", () => {
    expect(MIN_PAIRED_CASES).toBe(3);
    const two = ["case-a", "case-b"];
    const goal = judgeGoal(
      "outputTokens",
      report(two),
      report(two, () => ({ usage: { outputTokens: 10 } })),
    );
    expect(goal).toMatchObject({ change: -90, pairedCases: 2, outcome: "inconclusive" });
    const analysis = analyzeVariant(
      variant,
      "outputTokens",
      report(two),
      report(two, () => ({ usage: { outputTokens: 10 } })),
      DEFAULT_GUARDRAILS,
    );
    expect(analysis.why).toMatch(/Only 2 cases ran on both sides/);
  });

  it("is inconclusive with no case on both sides", () => {
    const goal = judgeGoal("latencyP50", control, report(["case-z"]));
    expect(goal.pairedCases).toBe(0);
    expect(goal.outcome).toBe("inconclusive");
  });
});

describe("checkGuardrails (GRV-110)", () => {
  it("passes every guardrail for a variant that changes nothing", () => {
    expect(checkGuardrails(control, report(CASES), DEFAULT_GUARDRAILS)).toSatisfy(
      (rows: { pass: boolean }[]) => rows.every((row) => row.pass),
    );
  });

  it("refuses check 1 or 8 falling more than 3 points in a set, and holds at exactly 3", () => {
    const big = report(["case-a"], () => ({}), 100);
    const atLimit = report(
      ["case-a"],
      (_, index) => ({ valid: index < 3 ? "fail" : "pass" }),
      100,
    );
    const past = report(
      ["case-a"],
      (_, index) => ({ outcome: index < 4 ? "fail" : "pass" }),
      100,
    );
    const limits = DEFAULT_GUARDRAILS;
    const of = (current: EvalReport, id: string) =>
      checkGuardrails(big, current, limits).find((entry) => entry.id === id);
    expect(of(atLimit, "applies")?.pass).toBe(true);
    // 3 fails in 200 judgements is 1.5 points: inside the overall 2.
    expect(of(atLimit, "overall")?.pass).toBe(true);
    expect(of(past, "expectMatch")?.pass).toBe(false);
    expect(of(past, "expectMatch")?.detail).toBe(
      "Musical capability 100.0% to 96.0% (too far)",
    );
    // An experiment may tighten the bar.
    expect(
      checkGuardrails(big, atLimit, { ...limits, maxCheckDropPoints: 1 }).find(
        (entry) => entry.id === "applies",
      )?.pass,
    ).toBe(false);
  });

  it("judges checks 1 and 8 in each set on its own", () => {
    const twoSets = (failBasic: boolean) =>
      buildTestReport(
        ["case-a", "case-b"].flatMap((caseId) =>
          Array.from({ length: 3 }, (_, index) =>
            testRecord({
              caseId,
              run: index + 1,
              set: caseId === "case-a" ? "musical" : "basicActions",
              valid: failBasic && caseId === "case-b" && index === 0 ? "fail" : "pass",
            }),
          ),
        ),
      );
    const result = checkGuardrails(
      twoSets(false),
      twoSets(true),
      DEFAULT_GUARDRAILS,
    ).find((entry) => entry.id === "applies");
    expect(result?.pass).toBe(false);
    expect(result?.detail).toBe(
      "Musical capability 100.0% to 100.0%; Basic production actions 100.0% to 66.7% (too far)",
    );
  });

  it("refuses the overall pass rate falling more than 2 points", () => {
    const worse = report(CASES, (caseId, index) => ({
      outcome: caseId === "case-a" && index === 0 ? "fail" : "pass",
    }));
    expect(guardrail("overall", worse)?.pass).toBe(false);
  });

  it("refuses a case that passed in most runs and fails in most", () => {
    const regressed = report(CASES, (caseId, index) => ({
      valid: caseId === "case-b" && index > 0 ? "fail" : "pass",
    }));
    expect(caseRegressions(control, regressed)).toEqual(["case-b"]);
    expect(guardrail("caseRegressions", regressed)).toMatchObject({
      pass: false,
      detail: "`case-b`",
    });
    // One failed run of three is not most of them.
    const wobble = report(CASES, (caseId, index) => ({
      valid: caseId === "case-b" && index === 0 ? "fail" : "pass",
    }));
    expect(caseRegressions(control, wobble)).toEqual([]);
  });

  it("refuses any rise in max_tokens stops or errored turns", () => {
    const cutOff = report(CASES, (caseId, index) => ({
      stopReason: caseId === "case-a" && index === 0 ? "max_tokens" : "tool_use",
    }));
    expect(guardrail("maxTokens", cutOff)).toMatchObject({
      pass: false,
      detail: "0 of 9 turns to 1 of 9",
    });
    const errored = report(CASES, (caseId, index) => ({
      errorCode: caseId === "case-c" && index === 2 ? "provider_error" : undefined,
    }));
    expect(guardrail("errored", errored)?.pass).toBe(false);
    expect(guardrail("errored", control)?.pass).toBe(true);
  });
});

describe("analyzeVariant (GRV-110)", () => {
  it("wins on a better goal with every guardrail held", () => {
    const fewer = report(CASES, () => ({ usage: { outputTokens: 60 } }));
    const analysis = analyzeVariant(
      variant,
      "outputTokens",
      control,
      fewer,
      DEFAULT_GUARDRAILS,
    );
    expect(analysis.verdict).toBe("win");
  });

  it("is refused by a guardrail however much the goal improved", () => {
    const broken = report(CASES, () => ({ usage: { outputTokens: 10 }, valid: "fail" }));
    const analysis = analyzeVariant(
      variant,
      "outputTokens",
      control,
      broken,
      DEFAULT_GUARDRAILS,
    );
    expect(analysis.goal.outcome).toBe("better");
    expect(analysis.verdict).toBe("no win");
    expect(analysis.why).toMatch(/^Refused by 3 guardrails: Applies cleanly/);
  });

  it("is no win on a worse goal, and inconclusive on no change", () => {
    const more = report(CASES, () => ({ usage: { outputTokens: 150 } }));
    expect(
      analyzeVariant(variant, "outputTokens", control, more, DEFAULT_GUARDRAILS).verdict,
    ).toBe("no win");
    expect(
      analyzeVariant(variant, "outputTokens", control, report(CASES), DEFAULT_GUARDRAILS)
        .verdict,
    ).toBe("inconclusive");
  });
});

describe("analyzeCut (GRV-110 section 5a)", () => {
  const trim = { name: "trim", overrides: { trimRules: "on" }, kind: "cut" as const };
  const cutOf = (
    current: EvalReport,
    limits: ExperimentGuardrails = DEFAULT_GUARDRAILS,
  ) => analyzeCut(trim, "outputTokens", control, current, limits);

  it("keeps a cut that changes nothing: neutral is a pass, never inconclusive", () => {
    const analysis = cutOf(report(CASES));
    expect(analysis).toMatchObject({ kind: "cut", verdict: "keep", cutMargin: 2 });
    // analyzeVariant hands a cut to the same rule.
    expect(
      analyzeVariant(trim, "outputTokens", control, report(CASES), DEFAULT_GUARDRAILS)
        .verdict,
    ).toBe("keep");
  });

  it("keeps a cut whose worse end stays within 2% of the control, and restores one past it", () => {
    // 100 tokens a turn: 2% is 2 tokens.
    expect(cutOf(report(CASES, () => ({ usage: { outputTokens: 102 } }))).verdict).toBe(
      "keep",
    );
    const over = cutOf(report(CASES, () => ({ usage: { outputTokens: 103 } })));
    expect(over.verdict).toBe("restore");
    expect(over.why).toMatch(/worse than the control by more than 2% of its value/);
    // A tighter margin restores what 2% kept.
    expect(
      cutOf(
        report(CASES, () => ({ usage: { outputTokens: 102 } })),
        {
          ...DEFAULT_GUARDRAILS,
          cutMarginPercent: 1,
        },
      ).verdict,
    ).toBe("restore");
    // Better is fine too: a cut needs no gain, and turns none away.
    expect(cutOf(report(CASES, () => ({ usage: { outputTokens: 50 } }))).verdict).toBe(
      "keep",
    );
  });

  it("restores a cut that breaks a guardrail, and one with too few cases to show anything", () => {
    const broken = cutOf(report(CASES, () => ({ valid: "fail" })));
    expect(broken.verdict).toBe("restore");
    expect(broken.why).toMatch(/^Refused by/);
    const few = analyzeCut(
      trim,
      "outputTokens",
      report(["case-a"]),
      report(["case-a"]),
      DEFAULT_GUARDRAILS,
    );
    expect(few.verdict).toBe("restore");
    expect(few.why).toMatch(/Only 1 case ran on both sides/);
  });

  it("reads the worse end the other way for a goal where higher is better", () => {
    const worse = report(CASES, (caseId, index) => ({
      valid: caseId === "case-a" && index === 0 ? "fail" : "pass",
    }));
    const analysis = analyzeCut(trim, "quality", control, worse, {
      ...DEFAULT_GUARDRAILS,
      maxOverallDropPoints: 100,
      maxCheckDropPoints: 100,
    });
    expect(analysis.goal.higherIsBetter).toBe(true);
    expect(analysis.verdict).toBe("restore");
    expect(analysis.why).toMatch(/Overall pass rate may be worse/);
  });
});

// GRV-145: a focus within the pool, the stricter guardrails, and a phase
// judged on the guardrails alone.
describe("a focus and the stricter guardrails (GRV-145)", () => {
  const POOL = ["case-a", "case-b", "case-c", "case-d"];
  const FOCUS = ["case-a", "case-b", "case-c"];
  const STRICT: ExperimentGuardrails = {
    ...DEFAULT_GUARDRAILS,
    noMaxTokens: true,
    outputTokensPerTurn: true,
    everyTurnChecks: ["noEmptyClips", "clipsPlaced"],
  };
  const pool = report(POOL);

  /** A session of `turns` turns, each `outputTokens` long and its checks as given. */
  function session(
    caseId: string,
    run: number,
    turns: readonly { outputTokens: number; noEmptyClips?: "pass" | "fail" }[],
  ) {
    const base = testRecord({ caseId, run, set: "musical" });
    return {
      ...base,
      session: {
        maxTurns: 5,
        ended: "done" as const,
        turns: turns.map((entry, index) => ({
          ...testRecord({ caseId, usage: { outputTokens: entry.outputTokens } }),
          turn: index + 1,
          request: "Next.",
        })),
      },
      turnChecks: turns.map((entry) => ({
        valid: { status: "pass" as const, detail: "" },
        noEmptyClips: { status: entry.noEmptyClips ?? ("pass" as const), detail: "" },
        clipsPlaced: { status: "pass" as const, detail: "" },
      })),
    };
  }

  it("reads the goal from the focus cases alone", () => {
    // Better only on case-d, outside the focus: nothing for the goal.
    const outside = report(POOL, (caseId) => ({
      usage: { outputTokens: caseId === "case-d" ? 10 : 100 },
    }));
    const goal = judgeGoal("outputTokens", pool, outside, FOCUS);
    expect(goal).toMatchObject({ change: 0, pairedCases: 3, control: 100, variant: 100 });
    expect(goal.label).toBe("Output tokens per turn on the focus cases");
    expect(judgeGoal("outputTokens", pool, outside).pairedCases).toBe(4);
  });

  it("adds the stricter guardrails only when asked, judged on the focus cases", () => {
    const ids = (limits: ExperimentGuardrails) =>
      checkGuardrails(pool, pool, limits, FOCUS).map((entry) => entry.id);
    expect(ids(DEFAULT_GUARDRAILS)).not.toContain("noMaxTokens");
    expect(ids(STRICT).slice(-3)).toEqual([
      "noMaxTokens",
      "outputTokensPerTurn",
      "everyTurnChecks",
    ]);
    expect(checkGuardrails(pool, pool, STRICT, FOCUS).every((entry) => entry.pass)).toBe(
      true,
    );
    // A cut-off reply outside the focus is the default bar's business only.
    const outside = report(POOL, (caseId, index) =>
      caseId === "case-d" && index === 0 ? { errorCode: "reply_too_long" } : {},
    );
    const strict = checkGuardrails(pool, outside, STRICT, FOCUS);
    expect(strict.find((entry) => entry.id === "noMaxTokens")?.pass).toBe(true);
    expect(strict.find((entry) => entry.id === "maxTokens")?.pass).toBe(false);
  });

  it("refuses any max_tokens stop on a focus case, even one the control had too", () => {
    const cut = report(POOL, (caseId, index) =>
      caseId === "case-a" && index === 0 ? { errorCode: "reply_too_long" } : {},
    );
    const result = checkGuardrails(cut, cut, STRICT, FOCUS).find(
      (entry) => entry.id === "noMaxTokens",
    );
    expect(result).toMatchObject({ pass: false, detail: "1 of 9 runs" });
    expect(result?.label).toBe("No max_tokens stop on the focus cases");
  });

  it("holds a session's output tokens per turn to the control's single turn", () => {
    const single = buildTestReport(
      FOCUS.map((caseId) => testRecord({ caseId, usage: { outputTokens: 9_000 } })),
    );
    const lighter = buildTestReport(
      FOCUS.map((caseId) =>
        session(caseId, 1, [{ outputTokens: 4_000 }, { outputTokens: 5_000 }]),
      ),
    );
    const heavier = buildTestReport(
      FOCUS.map((caseId) =>
        session(caseId, 1, [{ outputTokens: 9_000 }, { outputTokens: 9_500 }]),
      ),
    );
    const perTurn = (current: EvalReport) =>
      checkGuardrails(single, current, STRICT, FOCUS).find(
        (entry) => entry.id === "outputTokensPerTurn",
      );
    expect(perTurn(lighter)).toMatchObject({
      pass: true,
      detail: "9,000 over 3 turns to 4,500 over 6",
    });
    expect(perTurn(heavier)?.pass).toBe(false);
  });

  it("refuses a check failing on any turn's own proposal, though the final song passes", () => {
    const sessions = buildTestReport([
      session("case-a", 1, [{ outputTokens: 100 }, { outputTokens: 100 }]),
      session("case-b", 1, [
        { outputTokens: 100, noEmptyClips: "fail" },
        { outputTokens: 100 },
      ]),
    ]);
    const result = checkGuardrails(sessions, sessions, STRICT, FOCUS).find(
      (entry) => entry.id === "everyTurnChecks",
    );
    expect(result).toMatchObject({ pass: false, detail: "1 of 4 turns failed" });
    expect(result?.label).toBe(
      "Checks 16 and 20 hold on every turn's proposal on the focus cases",
    );
  });

  it("judges a phase on the guardrails alone when told: a win, or a keep, when every one holds", () => {
    const options = { focus: FOCUS, guardrailsOnly: true };
    const heldout = report(["case-x", "case-y"]);
    const improve = analyzeVariant(variant, "quality", heldout, heldout, STRICT, options);
    expect(improve.verdict).toBe("win");
    expect(improve.goal.pairedCases).toBe(0);
    expect(improve.why).toMatch(/only the guardrails judge it/);
    const cut = analyzeVariant(
      { ...variant, kind: "cut" },
      "quality",
      heldout,
      heldout,
      STRICT,
      options,
    );
    expect(cut.verdict).toBe("keep");
    const broken = report(["case-x", "case-y"], () => ({ valid: "fail" }));
    expect(
      analyzeVariant(variant, "quality", heldout, broken, STRICT, options).verdict,
    ).toBe("no win");
    // Without it, no paired case is inconclusive, as ever.
    expect(
      analyzeVariant(variant, "quality", heldout, heldout, STRICT, { focus: FOCUS })
        .verdict,
    ).toBe("inconclusive");
  });
});
