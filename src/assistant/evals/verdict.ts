/**
 * How an experiment judges one variant against the control (GRV-110): the
 * goal metric's change with its paired per-case interval (`bootstrap.ts`),
 * every guardrail pass or fail, and a verdict.
 *
 * - **win**: the interval lies wholly on the better side of zero, and every
 *   guardrail holds.
 * - **no win**: a guardrail failed (the variant is refused, whatever the goal
 *   did), or the interval lies wholly on the worse side.
 * - **inconclusive**: every guardrail holds and the interval crosses zero,
 *   or fewer than {@link MIN_PAIRED_CASES} cases ran on both sides, too few
 *   for a bootstrap over cases to say anything.
 *
 * A **cut** (GRV-110 section 5a) is judged by {@link analyzeCut} instead: it
 * needs no gain, only the bar. It is **keep** when every guardrail holds and
 * its goal is no worse than the control's beyond noise (the worse end of its
 * interval stays within `cutMarginPercent`, 2% by default, of the control's
 * value), and **restore** otherwise. Never inconclusive, since neutral passes.
 *
 * An experiment with a **focus** (GRV-145) reads its goal from the focus
 * cases alone, and its stricter guardrails judge only them; the default ones
 * judge every case. A gate with no focus case in it is judged on the
 * guardrails alone ({@link AnalyzeOptions.guardrailsOnly}).
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
import { CHECK_IDS, CHECK_LABELS } from "./checks";
import type { ExperimentGoal, ExperimentGuardrails, VariantKind } from "./experiment";
import type { EvalRecord, EvalReport } from "./run";
import {
  byTurnOf,
  formatMetric,
  type MetricKind,
  type Rate,
  type ScoreView,
  stopReasonOf,
} from "./scorecard";
import { setLabel } from "./sets";

export type ExperimentVerdict = "win" | "no win" | "inconclusive";

/** A cut's verdict: it stays out (keep the cut), or it goes back in (restore). */
export type CutVerdict = "keep" | "restore";

export type VariantVerdict = ExperimentVerdict | CutVerdict;

/** The fewest paired cases an interval is read from; fewer is inconclusive. */
export const MIN_PAIRED_CASES = 3;

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

/** The mean of each focus case's value, over the cases that have one. */
function focusMean(
  metric: GoalMetric,
  report: EvalReport,
  focus: readonly string[],
): number | null {
  const values = report.caseIds
    .filter((caseId) => focus.includes(caseId))
    .map((caseId) => metric.perCase(report, caseId))
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : mean(values);
}

/**
 * The goal's change, paired case by case, with its bootstrap interval. With a
 * `focus`, only the focus cases are paired, and each side's value is the mean
 * of its focus cases' values.
 */
export function judgeGoal(
  goal: ExperimentGoal,
  control: EvalReport,
  variant: EvalReport,
  focus: readonly string[] | null = null,
): GoalResult {
  const metric = GOAL_METRICS[goal];
  const differences: number[] = [];
  for (const caseId of control.caseIds) {
    if (focus && !focus.includes(caseId)) continue;
    const before = metric.perCase(control, caseId);
    const after = metric.perCase(variant, caseId);
    if (before !== null && after !== null) differences.push(after - before);
  }
  const interval = pairedBootstrap(differences);
  return {
    goal,
    label: focus ? `${metric.label} on the focus cases` : metric.label,
    kind: metric.kind,
    higherIsBetter: metric.higherIsBetter,
    control: focus ? focusMean(metric, control, focus) : metric.overall(control),
    variant: focus ? focusMean(metric, variant, focus) : metric.overall(variant),
    change: differences.length === 0 ? null : mean(differences),
    interval,
    pairedCases: differences.length,
    outcome:
      differences.length < MIN_PAIRED_CASES
        ? "inconclusive"
        : intervalOutcome(interval, metric.higherIsBetter),
  };
}

export type GuardrailId =
  | "applies"
  | "expectMatch"
  | "notFlattened"
  | "overall"
  | "caseRegressions"
  | "maxTokens"
  | "errored"
  | "noMaxTokens"
  | "outputTokensPerTurn"
  | "everyTurnChecks";

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

/**
 * The runs check 6 is judged from: the control's and the variant's reports
 * on a phase's check-6 block (`Experiment.flattening`), which only this
 * guardrail reads.
 */
export interface FlatteningReports {
  readonly control: EvalReport;
  readonly variant: EvalReport;
}

/** A case's check-6 runs: how many passed of how many judged. */
function notFlattenedTally(
  report: EvalReport,
  caseId: string,
): { pass: number; judged: number } {
  let pass = 0;
  let judged = 0;
  for (const record of report.records) {
    if (record.caseId !== caseId || record.error) continue;
    const status = record.checks.notFlattened?.status;
    if (status === "pass") pass += 1;
    if (status === "pass" || status === "fail") judged += 1;
  }
  return { pass, judged };
}

/**
 * Check 6 as a guardrail (GRV-141): no extreme case the control kept
 * unflattened in most of its runs is flattened in most of the variant's.
 *
 * It is a case-level rule, like {@link caseRegressions}, rather than a point
 * limit: the block holds two or three extreme cases at three to five runs
 * each, so one run is 7 to 17 points of the rate, and any limit tighter than
 * checks 1 and 8's 3 points would refuse a variant over a single noisy run.
 * A majority absorbs one such run and still refuses an extreme request the
 * variant answers conventionally most of the time.
 *
 * A guardrail with nothing to judge does not hold: with no extreme case
 * judged on both sides (no block ran, or every such turn errored or made no
 * proposal) it reports not measured and fails.
 */
export function notFlattenedGuardrail(
  flattening: FlatteningReports | null | undefined,
): GuardrailResult {
  const label =
    "Extreme is not flattened (check 6): no extreme case flattened in most runs";
  if (!flattening) {
    return {
      id: "notFlattened",
      label,
      pass: false,
      detail: "not measured: the check-6 block did not run",
    };
  }
  const caseIds = [
    ...new Set(
      [...flattening.control.records, ...flattening.variant.records]
        .filter((record) => record.checks.notFlattened !== undefined)
        .map((record) => record.caseId),
    ),
  ];
  const rows = caseIds.map((caseId) => {
    const before = notFlattenedTally(flattening.control, caseId);
    const after = notFlattenedTally(flattening.variant, caseId);
    const measured = before.judged > 0 && after.judged > 0;
    const flattened =
      measured &&
      before.pass * 2 > before.judged &&
      (after.judged - after.pass) * 2 > after.judged;
    return { caseId, before, after, measured, flattened };
  });
  const measured = rows.filter((row) => row.measured);
  const flattened = rows.filter((row) => row.flattened);
  return {
    id: "notFlattened",
    label,
    pass: measured.length > 0 && flattened.length === 0,
    detail:
      measured.length === 0
        ? "not measured: no extreme case was judged on both sides"
        : rows
            .map(
              (row) =>
                `\`${row.caseId}\` ${row.before.pass}/${row.before.judged} to ${row.after.pass}/${row.after.judged} unflattened${row.flattened ? " (flattened)" : row.measured ? "" : " (not measured)"}`,
            )
            .join("; "),
  };
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

/** The records of the focus cases, or every record without a focus. */
function focusRecords(
  report: EvalReport,
  focus: readonly string[] | null,
): readonly EvalRecord[] {
  return focus
    ? report.records.filter((record) => focus.includes(record.caseId))
    : report.records;
}

/** Where the stricter guardrails look, as their labels say it. */
function focusText(focus: readonly string[] | null): string {
  return focus ? " on the focus cases" : "";
}

/** The stricter guardrails the experiment added (GRV-145), on its focus cases. */
function strictGuardrails(
  control: EvalReport,
  variant: EvalReport,
  limits: ExperimentGuardrails,
  focus: readonly string[] | null,
): GuardrailResult[] {
  const before = focusRecords(control, focus);
  const after = focusRecords(variant, focus);
  const where = focusText(focus);
  const results: GuardrailResult[] = [];
  if (limits.noMaxTokens) {
    const stopped = after.filter((record) => stopReasonOf(record) === "max_tokens");
    results.push({
      id: "noMaxTokens",
      label: `No max_tokens stop${where}`,
      pass: stopped.length === 0,
      detail: `${stopped.length} of ${after.length} runs`,
    });
  }
  if (limits.outputTokensPerTurn) {
    const was = byTurnOf(before);
    const now = byTurnOf(after);
    const pass =
      was.outputTokens === null ||
      now.outputTokens === null ||
      now.outputTokens <= was.outputTokens + EPSILON;
    results.push({
      id: "outputTokensPerTurn",
      label: `Output tokens per turn no higher than the control's${where}`,
      pass,
      detail: `${formatMetric("tokens", was.outputTokens)} over ${was.turns} turns to ${formatMetric("tokens", now.outputTokens)} over ${now.turns}`,
    });
  }
  const checks = limits.everyTurnChecks ?? [];
  if (checks.length > 0) {
    const turns = after.flatMap((record) => record.turnChecks ?? [record.checks]);
    const failed = turns.filter((turn) =>
      checks.some((id) => turn[id]?.status === "fail"),
    );
    const numbers = checks.map((id) => CHECK_LABELS[id].split(".")[0]).join(" and ");
    results.push({
      id: "everyTurnChecks",
      label: `${checks.length === 1 ? `Check ${numbers} holds` : `Checks ${numbers} hold`} on every turn's proposal${where}`,
      pass: failed.length === 0,
      detail: `${failed.length} of ${turns.length} turns failed`,
    });
  }
  return results;
}

/** Every guardrail, the experiment's limits applied. */
export function checkGuardrails(
  control: EvalReport,
  variant: EvalReport,
  limits: ExperimentGuardrails,
  focus: readonly string[] | null = null,
  flattening?: FlatteningReports | null,
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
    ...(limits.holdNotFlattened ? [notFlattenedGuardrail(flattening)] : []),
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
    ...strictGuardrails(control, variant, limits, focus),
  ];
}

export interface VariantAnalysis {
  readonly variant: string;
  readonly overrides: Readonly<Record<string, string>>;
  readonly kind: VariantKind;
  readonly goal: GoalResult;
  readonly guardrails: readonly GuardrailResult[];
  /** An improve's win, no win or inconclusive; a cut's keep or restore. */
  readonly verdict: VariantVerdict;
  /** One line on why. */
  readonly why: string;
  /** A cut's noise margin: how much worse its goal may be, in the goal's unit. */
  readonly cutMargin?: number | null;
}

/** A variant as the analyses take it. */
export interface AnalyzedVariant {
  readonly name: string;
  readonly overrides: Readonly<Record<string, string>>;
  readonly kind?: VariantKind;
}

/** How a variant is judged beyond its own goal and guardrails. */
export interface AnalyzeOptions {
  /** The experiment's focus cases (GRV-145), or null for the whole pool. */
  readonly focus?: readonly string[] | null;
  /**
   * Judge the guardrails alone: a phase with none of the focus cases in it,
   * so no goal to read, as the held-out gate when no focus case is held
   * out. An improve wins, and a cut keeps, when every guardrail holds.
   */
  readonly guardrailsOnly?: boolean;
  /** The phase's check-6 block (GRV-141), for an experiment that holds check 6. */
  readonly flattening?: FlatteningReports | null;
}

/** The verdict when only the guardrails can say anything. */
function guardrailsVerdict(
  kind: VariantKind,
  failed: readonly GuardrailResult[],
): { verdict: VariantVerdict; why: string } {
  if (failed.length > 0) {
    return { verdict: kind === "cut" ? "restore" : "no win", why: refusedWhy(failed) };
  }
  return {
    verdict: kind === "cut" ? "keep" : "win",
    why: "No focus case ran here, so only the guardrails judge it, and every one held.",
  };
}

function refusedWhy(failed: readonly GuardrailResult[]): string {
  return `Refused by ${failed.length === 1 ? "a guardrail" : `${failed.length} guardrails`}: ${failed.map((guardrail) => guardrail.label).join("; ")}.`;
}

/** One variant against the control: its goal, its guardrails, its verdict. */
export function analyzeVariant(
  variant: AnalyzedVariant,
  goal: ExperimentGoal,
  control: EvalReport,
  report: EvalReport,
  limits: ExperimentGuardrails,
  options: AnalyzeOptions = {},
): VariantAnalysis {
  if (variant.kind === "cut") {
    return analyzeCut(variant, goal, control, report, limits, options);
  }
  const focus = options.focus ?? null;
  const goalResult = judgeGoal(goal, control, report, focus);
  const guardrails = checkGuardrails(control, report, limits, focus, options.flattening);
  const failed = guardrails.filter((guardrail) => !guardrail.pass);
  const base = {
    variant: variant.name,
    overrides: variant.overrides,
    kind: "improve" as const,
    goal: goalResult,
    guardrails,
  };
  if (options.guardrailsOnly) return { ...base, ...guardrailsVerdict("improve", failed) };
  if (failed.length > 0) {
    return { ...base, verdict: "no win", why: refusedWhy(failed) };
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
          : goalResult.pairedCases < MIN_PAIRED_CASES
            ? `Only ${goalResult.pairedCases} ${goalResult.pairedCases === 1 ? "case" : "cases"} ran on both sides, fewer than the ${MIN_PAIRED_CASES} an interval is read from.`
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
 * How far the worse end of a goal's interval lies on the worse side of zero,
 * in the goal's unit (negative when the whole interval is better); null with
 * no interval.
 */
export function worseBound(goal: GoalResult): number | null {
  if (!goal.interval) return null;
  return goal.higherIsBetter ? -goal.interval.low : goal.interval.high;
}

/**
 * One cut against the control: **keep** when every guardrail holds and the
 * worse end of its goal's interval stays within `cutMarginPercent` of the
 * control's value, over at least {@link MIN_PAIRED_CASES} paired cases;
 * **restore** otherwise.
 */
export function analyzeCut(
  variant: AnalyzedVariant,
  goal: ExperimentGoal,
  control: EvalReport,
  report: EvalReport,
  limits: ExperimentGuardrails,
  options: AnalyzeOptions = {},
): VariantAnalysis {
  const focus = options.focus ?? null;
  const goalResult = judgeGoal(goal, control, report, focus);
  const guardrails = checkGuardrails(control, report, limits, focus, options.flattening);
  const failed = guardrails.filter((guardrail) => !guardrail.pass);
  const margin =
    goalResult.control === null
      ? null
      : (Math.abs(goalResult.control) * limits.cutMarginPercent) / 100;
  const base = {
    variant: variant.name,
    overrides: variant.overrides,
    kind: "cut" as const,
    goal: goalResult,
    guardrails,
    cutMargin: margin,
  };
  if (options.guardrailsOnly) return { ...base, ...guardrailsVerdict("cut", failed) };
  if (failed.length > 0) return { ...base, verdict: "restore", why: refusedWhy(failed) };
  const bound = worseBound(goalResult);
  if (bound === null || margin === null || goalResult.pairedCases < MIN_PAIRED_CASES) {
    return {
      ...base,
      verdict: "restore",
      why: `Only ${goalResult.pairedCases} ${goalResult.pairedCases === 1 ? "case" : "cases"} ran on both sides, too few to show it costs nothing.`,
    };
  }
  if (bound > margin + EPSILON) {
    return {
      ...base,
      verdict: "restore",
      why: `${goalResult.label} may be worse than the control by more than ${limits.cutMarginPercent}% of its value.`,
    };
  }
  return {
    ...base,
    verdict: "keep",
    why: `Every guardrail held, and ${goalResult.label.toLowerCase()} is no worse than the control's beyond noise.`,
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
