/**
 * An experiment's report (GRV-110): Markdown for the card's comment, the run
 * summary and `docs/experiments/<id>.md`, and JSON for the artifact.
 *
 * It leads with the verdict, the winner and the cuts kept, then, phase by
 * phase, each variant against the control (cuts with their keep or restore,
 * their held-out run and every combined run, then a line per cut): the goal's change with its paired interval,
 * every guardrail, and every scorecard number beside the control's in
 * GRV-102's diff format (the control standing where the baseline does). The
 * JSON keeps every number and no reply, so it stays small; each variant's
 * full `report.json` is written beside it.
 */

import { CONTROL, describeCases, type ExperimentVariant } from "./experiment";
import type {
  CombinedCutRun,
  ExperimentGate,
  ExperimentPhase,
  ExperimentResult,
} from "./experimentRun";
import { type EvalReport, type EvalSummary, summaryOf } from "./run";
import {
  compareHeavySets,
  compareScorecards,
  formatDelta,
  formatMetric,
} from "./scorecard";
import { comparisonTables } from "./scorecardMarkdown";
import { GOAL_METRICS, type VariantAnalysis } from "./verdict";

/** Where the run happened and what it opened, for the report's links. */
export interface ExperimentLinks {
  /** The Actions run, or null for a local run. */
  readonly runUrl: string | null;
  /** The commit every variant ran against. */
  readonly commit: string | null;
  /** The held PR a win opened. */
  readonly pullRequestUrl?: string | null;
  /** Why the held PR a win should have opened did not open. */
  readonly pullRequestError?: string | null;
}

/** A variant's tactic values as the report names them; the control is production's. */
export function variantTactics(
  variant: Pick<ExperimentVariant, "name" | "overrides">,
): string {
  if (variant.name === CONTROL) return "production's defaults";
  return Object.entries(variant.overrides)
    .map(([id, value]) => `${id}=${value}`)
    .join(", ");
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
  const cutMargin =
    analysis.kind === "cut" && analysis.cutMargin != null
      ? [
          `- A cut keeps if the worse end of that interval is within ${formatMetric(analysis.goal.kind, analysis.cutMargin)} of the control (${formatMetric(analysis.goal.kind, analysis.goal.control)}).`,
        ]
      : [];
  return [
    `${heading} ${analysis.kind === "cut" ? "cut " : ""}\`${analysis.variant}\` against the control: ${analysis.verdict}`,
    "",
    `Tactics: ${variantTactics({ name: analysis.variant, overrides: analysis.overrides })}. ${analysis.why}`,
    "",
    `- Goal: ${goalLine(analysis)}`,
    ...cutMargin,
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
    ...comparisonTables(
      compareScorecards(variant.scorecard, control.scorecard),
      "#####",
      COLUMNS,
    ),
    ...(heavy
      ? ["##### Heavy set", "", ...comparisonTables(heavy, "#####", COLUMNS)]
      : []),
    "",
  ];
}

/** The diff tables' columns: the variant where the run is, the control where the baseline is. */
const COLUMNS = { current: "Variant", baseline: "Control" } as const;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function phaseIntro(phase: ExperimentPhase, cases: string): string[] {
  const turns = Object.values(phase.reports).reduce(
    (sum, report) => sum + report.records.length,
    0,
  );
  const block = phase.flattening
    ? ` Check 6 judged on its own block: ${phase.flattening.caseIds.map((id) => `\`${id}\``).join(", ")}.`
    : "";
  return [
    `${plural(phase.caseIds.length, cases)} (${phase.caseIds.map((id) => `\`${id}\``).join(", ")}), ${plural(phase.runsPerCase, "run")} a case, ${plural(turns, "turn")}.${block}${phase.stopped ? ` **Stopped early:** ${phase.stopped}` : ""}`,
    "",
  ];
}

function gateLines(gate: ExperimentGate): string[] {
  return [
    ...phaseIntro(gate.phase, "held-out case"),
    ...analysisLines(gate.analysis, gate.phase, "### Gate:"),
  ];
}

function combinedLines(run: CombinedCutRun, index: number): string[] {
  const heading = `### Combined run ${index + 1}: ${run.cuts.map((cut) => `\`${cut}\``).join(" + ")}, ${run.held ? "held" : "failed"}`;
  return [
    heading,
    "",
    ...phaseIntro(run.train.phase, "train case"),
    ...analysisLines(run.train.analysis, run.train.phase, "#### Train:"),
    ...(run.heldout
      ? [
          ...phaseIntro(run.heldout.phase, "held-out case"),
          ...analysisLines(run.heldout.analysis, run.heldout.phase, "#### Held out:"),
        ]
      : ["Not run on held-out: it did not keep on train.", ""]),
  ];
}

function cutLines(result: ExperimentResult): string[] {
  if (result.cuts.length === 0) return [];
  const { cutGate } = result;
  return [
    "## Cuts",
    "",
    "A cut needs no gain: it keeps when it holds every guardrail on train and on held-out and its goal is no worse than the control's beyond noise, and the cuts that keep alone must keep together too.",
    "",
    "| Cut | Verdict | Why |",
    "| --- | --- | --- |",
    ...result.cuts.map(
      (cut) =>
        `| \`${cut.name}\` | **${cut.verdict}** | ${cut.why.replace(/\|/g, "\\|")} |`,
    ),
    "",
    ...(cutGate
      ? [
          "### Cuts on held-out",
          "",
          ...phaseIntro(cutGate.phase, "held-out case"),
          ...cutGate.analyses.flatMap((analysis) =>
            analysisLines(analysis, cutGate.phase, "####"),
          ),
        ]
      : []),
    ...result.combined.flatMap(combinedLines),
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
    ...(result.cuts.length > 0
      ? [
          `- Cuts kept: ${result.keptCuts.length === 0 ? "none" : result.keptCuts.map((cut) => `\`${cut.name}\` (${variantTactics(cut)})`).join(", ")}`,
        ]
      : []),
    ...(links.pullRequestUrl
      ? [`- Held PR with the new defaults: ${links.pullRequestUrl}`]
      : []),
    ...(links.pullRequestError
      ? [`- **The held PR did not open:** ${links.pullRequestError}`]
      : []),
    `- Goal: ${goal.label.toLowerCase()} (${goal.higherIsBetter ? "higher" : "lower"} is better)`,
    `- Variants: ${experiment.variants.map((variant) => `\`${variant.name}\` (${variant.kind === "cut" ? "a cut: " : ""}${variantTactics(variant)})`).join(", ")}`,
    ...(experiment.atDefaults.length > 0
      ? [
          `- Not run, production's defaults already: ${experiment.atDefaults.map((name) => `\`${name}\``).join(", ")}`,
        ]
      : []),
    `- Cases: ${describeCases(experiment.cases)}: ${experiment.train.length} train, ${experiment.heldout.length} held out`,
    `- Guardrails: checks 1 and 8 within ${experiment.guardrails.maxCheckDropPoints} points per set, ${experiment.guardrails.holdNotFlattened ? "no extreme case flattened in most runs (check 6, on its own block of paired cases), " : ""}the overall pass rate within ${experiment.guardrails.maxOverallDropPoints}, no case passing to failing in most runs, no rise in max_tokens stops or errored turns${result.cuts.length > 0 ? `; a cut's goal no worse than ${experiment.guardrails.cutMarginPercent}% of the control's` : ""}`,
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
    ...phaseIntro(result.train, "train case"),
    ...result.trainAnalyses.flatMap((analysis) =>
      analysisLines(analysis, result.train, "###"),
    ),
    "## Held-out gate",
    "",
    ...(result.gates.length === 0
      ? [
          !result.trainAnalyses.some((analysis) => analysis.kind === "improve")
            ? "Not run: every variant is a cut (below)."
            : result.trainAnalyses.some((analysis) => analysis.verdict === "win")
              ? "Not run: the experiment stopped first."
              : "Not run: no variant won on train.",
          "",
        ]
      : result.gates.flatMap(gateLines)),
    ...cutLines(result),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A phase with every report's numbers and no reply. */
export interface ExperimentPhaseSummary
  extends Omit<ExperimentPhase, "reports" | "flattening"> {
  readonly reports: Readonly<Record<string, EvalSummary>>;
  readonly flattening: {
    readonly caseIds: readonly string[];
    readonly reports: Readonly<Record<string, EvalSummary>>;
  } | null;
}

function summaries(
  reports: Readonly<Record<string, EvalReport>>,
): Record<string, EvalSummary> {
  return Object.fromEntries(
    Object.entries(reports).map(([name, report]) => [name, summaryOf(report)]),
  );
}

function phaseSummary(phase: ExperimentPhase): ExperimentPhaseSummary {
  return {
    ...phase,
    reports: summaries(phase.reports),
    flattening: phase.flattening
      ? {
          caseIds: phase.flattening.caseIds,
          reports: summaries(phase.flattening.reports),
        }
      : null,
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
      flattening: {
        train: experiment.flattening.train.map((entry) => entry.id),
        heldout: experiment.flattening.heldout.map((entry) => entry.id),
      },
      guardrails: experiment.guardrails,
      runs: experiment.runs,
      budgetUsd: experiment.budgetUsd,
      atDefaults: experiment.atDefaults,
    },
    verdict: result.verdict,
    reason: result.reason,
    winner: result.winner,
    keptCuts: result.keptCuts,
    cuts: result.cuts,
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
    cutGate: result.cutGate
      ? { analyses: result.cutGate.analyses, phase: phaseSummary(result.cutGate.phase) }
      : null,
    combined: result.combined.map((run) => ({
      cuts: run.cuts,
      variant: run.variant,
      held: run.held,
      train: { analysis: run.train.analysis, phase: phaseSummary(run.train.phase) },
      heldout: run.heldout
        ? { analysis: run.heldout.analysis, phase: phaseSummary(run.heldout.phase) }
        : null,
    })),
  };
}
