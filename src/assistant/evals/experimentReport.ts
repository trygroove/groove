/**
 * An experiment's report (GRV-110): Markdown for the card's comment, the run
 * summary and `docs/experiments/<id>.md`, and JSON for the artifact.
 *
 * It leads with the verdict and the winner, then, phase by phase, each
 * variant against the control: the goal's change with its paired interval,
 * every guardrail, and every scorecard number beside the control's in
 * GRV-102's diff format (the control standing where the baseline does). The
 * JSON keeps every number and no reply, so it stays small; each variant's
 * full `report.json` is written beside it.
 */

import { CONTROL, describeCases, type ExperimentVariant } from "./experiment";
import type { ExperimentGate, ExperimentPhase, ExperimentResult } from "./experimentRun";
import { type EvalSummary, summaryOf } from "./run";
import {
  compareHeavySets,
  compareScorecards,
  formatDelta,
  formatMetric,
} from "./scorecard";
import { comparisonTables, tacticsText } from "./scorecardMarkdown";
import { GOAL_METRICS, type VariantAnalysis } from "./verdict";

/** Where the run happened and what it opened, for the report's links. */
export interface ExperimentLinks {
  /** The Actions run, or null for a local run. */
  readonly runUrl: string | null;
  /** The commit every variant ran against. */
  readonly commit: string | null;
  /** The held PR a win opened. */
  readonly pullRequestUrl?: string | null;
}

/** A variant's tactic values as the report names them; the control is production's. */
export function variantTactics(
  variant: Pick<ExperimentVariant, "name" | "overrides">,
): string {
  if (variant.name === CONTROL) return "production's defaults";
  return tacticsText(variant.overrides);
}

function intervalText(analysis: VariantAnalysis): string {
  const { goal } = analysis;
  if (!goal.interval) return "no interval (no case ran on both sides)";
  return `${Math.round(goal.interval.level * 100)}% interval ${formatDelta(goal.kind, goal.interval.low)} to ${formatDelta(goal.kind, goal.interval.high)} over ${goal.pairedCases} paired ${goal.pairedCases === 1 ? "case" : "cases"}`;
}

/** The goal's change as one line: "Output tokens per turn 9,000 to 6,000: -3,000 (95% interval ...)". */
export function goalLine(analysis: VariantAnalysis): string {
  const { goal } = analysis;
  return `${goal.label} ${formatMetric(goal.kind, goal.control)} to ${formatMetric(goal.kind, goal.variant)}; per-case change ${formatDelta(goal.kind, goal.change)} (${intervalText(analysis)}): **${goal.outcome}**`;
}

function analysisLines(
  analysis: VariantAnalysis,
  phase: ExperimentPhase,
  heading: string,
): string[] {
  const control = phase.reports[CONTROL];
  const variant = phase.reports[analysis.variant];
  const heavy = compareHeavySets(variant.scorecard, control.scorecard);
  return [
    `${heading} \`${analysis.variant}\` against the control: ${analysis.verdict}`,
    "",
    `Tactics: ${variantTactics({ name: analysis.variant, overrides: analysis.overrides })}. ${analysis.why}`,
    "",
    `- Goal: ${goalLine(analysis)}`,
    "",
    "| Guardrail | | Control to variant |",
    "| --- | --- | --- |",
    ...analysis.guardrails.map(
      (guardrail) =>
        `| ${guardrail.label} | ${guardrail.pass ? "pass" : "**fail**"} | ${guardrail.detail} |`,
    ),
    "",
    `#### Every number beside the control's`,
    "",
    ...comparisonTables(compareScorecards(variant.scorecard, control.scorecard), "#####"),
    ...(heavy ? ["##### Heavy set", "", ...comparisonTables(heavy)] : []),
    "",
  ];
}

function phaseIntro(phase: ExperimentPhase, cases: string): string[] {
  const turns = Object.values(phase.reports).reduce(
    (sum, report) => sum + report.records.length,
    0,
  );
  return [
    `${phase.caseIds.length} ${cases} (${phase.caseIds.map((id) => `\`${id}\``).join(", ")}), ${phase.runsPerCase} runs a case, ${turns} turns.${phase.stopped ? ` **Stopped early:** ${phase.stopped}` : ""}`,
    "",
  ];
}

function gateLines(gate: ExperimentGate): string[] {
  return [
    ...phaseIntro(gate.phase, "held-out cases"),
    ...analysisLines(gate.analysis, gate.phase, "### Gate:"),
  ];
}

/** The report as Markdown. */
export function renderExperimentMarkdown(
  result: ExperimentResult,
  links: ExperimentLinks,
): string {
  const { experiment } = result;
  const goal = GOAL_METRICS[experiment.goal];
  const control = result.train.reports[CONTROL];
  const lines = [
    `# Experiment \`${experiment.id}\`: ${result.verdict}`,
    "",
    `> ${experiment.hypothesis}`,
    "",
    `- Card: ${experiment.card}`,
    `- Verdict: **${result.verdict}**. ${result.reason}`,
    ...(result.winner
      ? [`- Winner: \`${result.winner.name}\` (${variantTactics(result.winner)})`]
      : []),
    ...(links.pullRequestUrl
      ? [`- Held PR with the new defaults: ${links.pullRequestUrl}`]
      : []),
    `- Goal: ${goal.label.toLowerCase()} (${goal.higherIsBetter ? "higher" : "lower"} is better)`,
    `- Variants: ${experiment.variants.map((variant) => `\`${variant.name}\` (${variantTactics(variant)})`).join(", ")}`,
    `- Cases: ${describeCases(experiment.cases)}: ${experiment.train.length} train, ${experiment.heldout.length} held out`,
    `- Guardrails: checks 1 and 8 within ${experiment.guardrails.maxCheckDropPoints} points per set, the overall pass rate within ${experiment.guardrails.maxOverallDropPoints}, no case passing to failing in most runs, no rise in max_tokens stops or errored turns`,
    `- Model: \`${result.model}\`; prompt \`${control.promptVersion}\`; tool set ${control.toolsetVersion}`,
    `- Commit: ${links.commit ? `\`${links.commit}\`` : "unknown"}; run: ${links.runUrl ?? "local"}`,
    `- Spend: $${result.spentUsd.toFixed(2)} of a $${result.budgetUsd.toFixed(2)} budget`,
    `- Generated: ${result.generatedAt}`,
    "",
    ...(result.stopped
      ? [`**Unfinished.** ${result.stopped} What follows is what it has.`, ""]
      : []),
    "## Train",
    "",
    ...phaseIntro(result.train, "train cases"),
    ...result.trainAnalyses.flatMap((analysis) =>
      analysisLines(analysis, result.train, "###"),
    ),
    "## Held-out gate",
    "",
    ...(result.gates.length === 0
      ? [
          result.trainAnalyses.some((analysis) => analysis.verdict === "win")
            ? "Not run: the experiment stopped first."
            : "Not run: no variant won on train.",
          "",
        ]
      : result.gates.flatMap(gateLines)),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A phase with every report's numbers and no reply. */
export interface ExperimentPhaseSummary extends Omit<ExperimentPhase, "reports"> {
  readonly reports: Readonly<Record<string, EvalSummary>>;
}

function phaseSummary(phase: ExperimentPhase): ExperimentPhaseSummary {
  return {
    ...phase,
    reports: Object.fromEntries(
      Object.entries(phase.reports).map(([name, report]) => [name, summaryOf(report)]),
    ),
  };
}

/** The report as JSON: every number, every verdict, no reply. */
export function experimentJson(result: ExperimentResult, links: ExperimentLinks) {
  const { experiment } = result;
  return {
    experiment: {
      id: experiment.id,
      card: experiment.card,
      hypothesis: experiment.hypothesis,
      goal: experiment.goal,
      variants: experiment.variants,
      cases: experiment.cases,
      train: experiment.train.map((entry) => entry.id),
      heldout: experiment.heldout.map((entry) => entry.id),
      guardrails: experiment.guardrails,
      runs: experiment.runs,
    },
    verdict: result.verdict,
    reason: result.reason,
    winner: result.winner,
    stopped: result.stopped,
    model: result.model,
    generatedAt: result.generatedAt,
    budgetUsd: result.budgetUsd,
    spentUsd: result.spentUsd,
    links,
    trainAnalyses: result.trainAnalyses,
    gates: result.gates.map((gate) => ({
      variant: gate.variant,
      analysis: gate.analysis,
      phase: phaseSummary(gate.phase),
    })),
    train: phaseSummary(result.train),
  };
}
