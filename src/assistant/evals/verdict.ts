/**
 * How an experiment judges one variant against the control (GRV-110): the
 * goal metric's change with its paired per-case interval (`bootstrap.ts`),
 * every guardrail pass or fail, and a verdict.
 *
 * - **win**: the interval lies wholly on the better side of zero, and every
 *   guardrail holds.
 * - **no win**: a guardrail failed (the variant is refused, whatever the goal
 *   did), or the interval lies wholly on the worse side.
 * - **inconclusive**: every guardrail holds and the interval crosses zero.
 *
 * Both reports must come from the same cases run the same way: an experiment
 * phase runs every variant in one interleaved pass (`experimentRun.ts`).
 */

import {
  type ConfidenceInterval,
  intervalOutcome,
  mean,
  pairedBootstrap,
} from "./bootstrap";
import { CHECK_IDS } from "./checks";
import type { ExperimentGoal, ExperimentGuardrails } from "./experiment";
import type { EvalRecord, EvalReport } from "./run";
import { type MetricKind, type Rate, type ScoreView, stopReasonOf } from "./scorecard";
import { setLabel } from "./sets";

export type ExperimentVerdict = "win" | "no win" | "inconclusive";

/** One goal: how to read it off a whole report, and off one case of it. */
export interface GoalMetric {
  readonly label: string;
  readonly kind: MetricKind;
  readonly higherIsBetter: boolean;
  readonly overall: (report: EvalReport) => number | null;
  readonly perCase: (report: EvalReport, caseId: string) => number | null;
}

function caseQuality(report: EvalReport, caseId: string): number | null {
  const tallies = report.summary.cases[caseId] ?? {};
  let pass = 0;
  let fail = 0;
  for (const id of CHECK_IDS) {
    pass += tallies[id]?.pass ?? 0;
    fail += tallies[id]?.fail ?? 0;
  }
  return pass + fail === 0 ? null : pass / (pass + fail);
}

function caseSecondary(report: EvalReport, caseId: string) {
  return report.scorecard.cases[caseId];
}

export const GOAL_METRICS: Readonly<Record<ExperimentGoal, GoalMetric>> = {
  quality: {
    label: "Overall pass rate",
    kind: "rate",
    higherIsBetter: true,
    overall: (report) => report.scorecard.headline.overall.rate,
    perCase: caseQuality,
  },
  outputTokens: {
    label: "Output tokens per turn",
    kind: "tokens",
    higherIsBetter: false,
    overall: (report) => report.scorecard.secondary.meanTokens.output,
    perCase: (report, caseId) => caseSecondary(report, caseId)?.meanTokens.output ?? null,
  },
  latencyP50: {
    label: "Latency p50",
    kind: "ms",
    higherIsBetter: false,
    overall: (report) => report.scorecard.secondary.latencyMs.p50,
    perCase: (report, caseId) => caseSecondary(report, caseId)?.latencyMs.p50 ?? null,
  },
  cost: {
    label: "Cost per turn",
    kind: "usd",
    higherIsBetter: false,
    overall: (report) => report.scorecard.secondary.costUsd.perTurn,
    perCase: (report, caseId) => caseSecondary(report, caseId)?.costUsd.perTurn ?? null,
  },
  firstTextP50: {
    label: "First text p50",
    kind: "ms",
    higherIsBetter: false,
    overall: (report) => report.scorecard.secondary.firstTextMs.p50,
    perCase: (report, caseId) => caseSecondary(report, caseId)?.firstTextMs.p50 ?? null,
  },
};

export interface GoalResult {
  readonly goal: ExperimentGoal;
  readonly label: string;
  readonly kind: MetricKind;
  readonly higherIsBetter: boolean;
  /** The metric over the whole of each report. */
  readonly control: number | null;
  readonly variant: number | null;
  /** The mean of the per-case differences, variant minus control; null with no case to pair. */
  readonly change: number | null;
  readonly interval: ConfidenceInterval | null;
  /** The cases both reports have the metric for. */
  readonly pairedCases: number;
  readonly outcome: "better" | "worse" | "inconclusive";
}

/** The goal's change, paired case by case, with its bootstrap interval. */
export function judgeGoal(
  goal: ExperimentGoal,
  control: EvalReport,
  variant: EvalReport,
): GoalResult {
  const metric = GOAL_METRICS[goal];
  const differences: number[] = [];
  for (const caseId of control.caseIds) {
    const before = metric.perCase(control, caseId);
    const after = metric.perCase(variant, caseId);
    if (before !== null && after !== null) differences.push(after - before);
  }
  const interval = pairedBootstrap(differences);
  return {
    goal,
    label: metric.label,
    kind: metric.kind,
    higherIsBetter: metric.higherIsBetter,
    control: metric.overall(control),
    variant: metric.overall(variant),
    change: differences.length === 0 ? null : mean(differences),
    interval,
    pairedCases: differences.length,
    outcome: intervalOutcome(interval, metric.higherIsBetter),
  };
}

export type GuardrailId =
  | "applies"
  | "expectMatch"
  | "overall"
  | "caseRegressions"
  | "maxTokens"
  | "errored";

export interface GuardrailResult {
  readonly id: GuardrailId;
  readonly label: string;
  readonly pass: boolean;
  /** What was compared, in a line of the report. */
  readonly detail: string;
}

const EPSILON = 1e-9;

function points(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/** Whether `after` is no more than `limit` points below `before`; a rate nothing judged passes. */
function withinPoints(before: Rate, after: Rate, limit: number): boolean {
  if (before.rate === null || after.rate === null) return true;
  return before.rate - after.rate <= limit / 100 + EPSILON;
}

/** A check's rate per set, held within `limit` points of the control's in every set. */
function perSetRate(
  id: GuardrailId,
  label: string,
  rate: (view: ScoreView) => Rate,
  control: EvalReport,
  variant: EvalReport,
  limit: number,
): GuardrailResult {
  const sets = Object.entries(control.scorecard.sets ?? {}).filter(
    ([set]) => variant.scorecard.sets?.[set] !== undefined,
  );
  const rows = sets.map(([set, score]) => {
    const before = rate(score);
    const after = rate(variant.scorecard.sets?.[set] as ScoreView);
    return { set, before, after, pass: withinPoints(before, after, limit) };
  });
  return {
    id,
    label: `${label} within ${limit} points in every set`,
    pass: rows.every((row) => row.pass),
    detail:
      rows.length === 0
        ? "no set ran on both sides"
        : rows
            .map(
              (row) =>
                `${setLabel(row.set)} ${points(row.before.rate)} to ${points(row.after.rate)}${row.pass ? "" : " (too far)"}`,
            )
            .join("; "),
  };
}

/** Whether a run passed: it replied, and no check that judged it failed. */
function runPassed(record: EvalRecord): boolean {
  return Object.values(record.checks).every((result) => result?.status !== "fail");
}

/** Whether most of a case's judged runs passed, or most failed; null with none judged. */
function majority(records: readonly EvalRecord[]): "pass" | "fail" | "split" | null {
  const judged = records.filter((record) => !record.error);
  if (judged.length === 0) return null;
  const passed = judged.filter(runPassed).length;
  if (passed * 2 > judged.length) return "pass";
  if ((judged.length - passed) * 2 > judged.length) return "fail";
  return "split";
}

/** The cases that passed in most of the control's runs and fail in most of the variant's. */
export function caseRegressions(control: EvalReport, variant: EvalReport): string[] {
  return control.caseIds.filter((caseId) => {
    const before = majority(control.records.filter((record) => record.caseId === caseId));
    const after = majority(variant.records.filter((record) => record.caseId === caseId));
    return before === "pass" && after === "fail";
  });
}

function share(count: number, of: number): number {
  return of === 0 ? 0 : count / of;
}

function countOf(report: EvalReport, test: (record: EvalRecord) => boolean): number {
  return report.records.filter(test).length;
}

/** A rate that may not rise: compared as shares of each side's turns, which match when both finished. */
function noRise(
  id: GuardrailId,
  label: string,
  control: EvalReport,
  variant: EvalReport,
  test: (record: EvalRecord) => boolean,
): GuardrailResult {
  const before = countOf(control, test);
  const after = countOf(variant, test);
  const pass =
    share(after, variant.records.length) <=
    share(before, control.records.length) + EPSILON;
  return {
    id,
    label,
    pass,
    detail: `${before} of ${control.records.length} turns to ${after} of ${variant.records.length}`,
  };
}

/** Every guardrail, the experiment's limits applied. */
export function checkGuardrails(
  control: EvalReport,
  variant: EvalReport,
  limits: ExperimentGuardrails,
): GuardrailResult[] {
  const overallPass = withinPoints(
    control.scorecard.headline.overall,
    variant.scorecard.headline.overall,
    limits.maxOverallDropPoints,
  );
  const regressions = caseRegressions(control, variant);
  return [
    perSetRate(
      "applies",
      "Applies cleanly (check 1)",
      (view) => view.headline.applies,
      control,
      variant,
      limits.maxCheckDropPoints,
    ),
    perSetRate(
      "expectMatch",
      "Expected outcome (check 8)",
      (view) => view.headline.expectMatch,
      control,
      variant,
      limits.maxCheckDropPoints,
    ),
    {
      id: "overall",
      label: `Overall pass rate within ${limits.maxOverallDropPoints} points`,
      pass: overallPass,
      detail: `${points(control.scorecard.headline.overall.rate)} to ${points(variant.scorecard.headline.overall.rate)}`,
    },
    {
      id: "caseRegressions",
      label: "No case goes from passing to failing in most runs",
      pass: regressions.length === 0,
      detail:
        regressions.length === 0
          ? "none"
          : regressions.map((caseId) => `\`${caseId}\``).join(", "),
    },
    noRise(
      "maxTokens",
      "No rise in max_tokens stops",
      control,
      variant,
      (record) => stopReasonOf(record) === "max_tokens",
    ),
    noRise("errored", "No rise in errored turns", control, variant, (record) =>
      Boolean(record.error),
    ),
  ];
}

export interface VariantAnalysis {
  readonly variant: string;
  readonly overrides: Readonly<Record<string, string>>;
  readonly goal: GoalResult;
  readonly guardrails: readonly GuardrailResult[];
  readonly verdict: ExperimentVerdict;
  /** One line on why. */
  readonly why: string;
}

/** One variant against the control: its goal, its guardrails, its verdict. */
export function analyzeVariant(
  variant: {
    readonly name: string;
    readonly overrides: Readonly<Record<string, string>>;
  },
  goal: ExperimentGoal,
  control: EvalReport,
  report: EvalReport,
  limits: ExperimentGuardrails,
): VariantAnalysis {
  const goalResult = judgeGoal(goal, control, report);
  const guardrails = checkGuardrails(control, report, limits);
  const failed = guardrails.filter((guardrail) => !guardrail.pass);
  const base = {
    variant: variant.name,
    overrides: variant.overrides,
    goal: goalResult,
    guardrails,
  };
  if (failed.length > 0) {
    return {
      ...base,
      verdict: "no win",
      why: `Refused by ${failed.length === 1 ? "a guardrail" : `${failed.length} guardrails`}: ${failed.map((guardrail) => guardrail.label).join("; ")}.`,
    };
  }
  if (goalResult.outcome === "worse") {
    return { ...base, verdict: "no win", why: `${goalResult.label} got worse.` };
  }
  if (goalResult.outcome === "inconclusive") {
    return {
      ...base,
      verdict: "inconclusive",
      why:
        goalResult.pairedCases === 0
          ? "No case ran on both sides, so there is nothing to compare."
          : `The interval on ${goalResult.label.toLowerCase()} crosses zero.`,
    };
  }
  return {
    ...base,
    verdict: "win",
    why: `${goalResult.label} improved, and every guardrail held.`,
  };
}

/**
 * How much better a variant's goal got, in the goal's own direction: larger
 * is better. For ranking winners.
 */
export function improvement(analysis: VariantAnalysis): number {
  const change = analysis.goal.change ?? 0;
  return analysis.goal.higherIsBetter ? change : -change;
}
