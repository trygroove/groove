import { describe, expect, it } from "vitest";
import {
  buildTestReport,
  type TestRecordOptions,
  testRecord,
} from "../../testing/evalRecords";
import { DEFAULT_GUARDRAILS } from "./experiment";
import type { EvalReport } from "./run";
import { analyzeVariant, caseRegressions, checkGuardrails, judgeGoal } from "./verdict";

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
