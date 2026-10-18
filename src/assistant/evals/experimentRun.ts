/**
 * Running an experiment (GRV-110): every variant through the evals, offline,
 * then the winner through the held-out gate, then the verdict.
 *
 * - **One pass per phase.** Every variant runs in the same pass against the
 *   same commit, interleaved case by case and run by run (case 1 run 1 for
 *   the control, then for each variant, then run 2, ...), so a drift in the
 *   model's speed or mood mid-run lands on every variant alike. Turns run
 *   {@link DEFAULT_EXPERIMENT_CONCURRENCY} in flight.
 * - **Train, then the gate.** The variants run on the experiment's train
 *   cases. Each that wins there (best first) reruns beside the control on
 *   the held-out cases, {@link GATE_RUNS_PER_CASE} runs a case; the first
 *   that wins there too is the winner.
 * - **The budget.** Spend is the sum of every finished turn's cost from its
 *   usage and the model's price (`budget.ts`). No turn starts that would be
 *   expected to take it past the budget, and an experiment stopped short
 *   reports what it has, its verdict `inconclusive`.
 *
 * Each turn goes through {@link runCaseTurn}, the gateway's own turn, with
 * the variant's tactic values; tests hand in their own turn runner, with a
 * scripted provider and planted tactics.
 */
import {
  ASSISTANT_MODEL_ID,
  ASSISTANT_MODELS,
  type AssistantModelProfile,
} from "../config";
import type { AssistantProvider } from "../provider";
import type { TacticOverrides } from "../tactics";
import { SpendTally } from "./budget";
import type { EvalCase } from "./cases";
import {
  CONTROL,
  type Experiment,
  type ExperimentVariant,
  GATE_RUNS_PER_CASE,
  type VariantTactics,
} from "./experiment";
import {
  AUTH_ABORT_REASON,
  buildReport,
  CREDIT_ABORT_REASON,
  type EvalRecord,
  type EvalReport,
  type EvalTurn,
  evaluateTurnSafely,
  isAuthError,
  runCaseTurn,
} from "./run";
import {
  analyzeVariant,
  type ExperimentVerdict,
  improvement,
  type VariantAnalysis,
} from "./verdict";

export const DEFAULT_EXPERIMENT_CONCURRENCY = 10;

export const DEFAULT_BUDGET_USD = 25;

export const BUDGET_STOP_REASON =
  "The experiment reached its budget, so no further turns were run.";

/** Runs one case once with a variant's tactic values. */
export type ExperimentTurnRunner = (
  evalCase: EvalCase,
  tactics: VariantTactics,
) => Promise<EvalTurn>;

/** The live turn: the gateway's own, against `provider`. */
export function gatewayTurnRunner(options: {
  readonly provider: AssistantProvider;
  readonly model: AssistantModelProfile;
  readonly turnTimeoutMs?: number;
  readonly now?: () => number;
}): ExperimentTurnRunner {
  return (evalCase, tactics) =>
    runCaseTurn(evalCase, {
      provider: options.provider,
      model: options.model,
      // Checked against the registry when the experiment was loaded.
      tactics: tactics as TacticOverrides,
      turnTimeoutMs: options.turnTimeoutMs,
      now: options.now,
    });
}

export type ExperimentPhaseName = "train" | "gate";

/** One phase: which cases ran how often, and each variant's report. */
export interface ExperimentPhase {
  readonly phase: ExperimentPhaseName;
  readonly caseIds: readonly string[];
  readonly runsPerCase: number;
  /** Each variant's report, by name, the control's first. */
  readonly reports: Readonly<Record<string, EvalReport>>;
  /** Why it stopped before every turn ran, or null when it did not. */
  readonly stopped: string | null;
}

export interface PhaseOptions {
  readonly phase: ExperimentPhaseName;
  readonly cases: readonly EvalCase[];
  readonly runs: number;
  readonly variants: readonly ExperimentVariant[];
  readonly runTurn: ExperimentTurnRunner;
  readonly model: AssistantModelProfile;
  readonly tally: SpendTally;
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly onRecord?: (variant: string, record: EvalRecord) => void;
}

interface Job {
  readonly evalCase: EvalCase;
  readonly run: number;
  readonly variant: ExperimentVariant;
}

/** Every variant over every case and run, interleaved case by case. */
export function interleave(
  cases: readonly EvalCase[],
  runs: number,
  variants: readonly ExperimentVariant[],
): Job[] {
  return cases.flatMap((evalCase) =>
    Array.from({ length: runs }, (_, index) =>
      variants.map((variant) => ({ evalCase, run: index + 1, variant })),
    ).flat(),
  );
}

/** Runs one phase, every variant in one interleaved pass, inside the budget. */
export async function runPhase(options: PhaseOptions): Promise<ExperimentPhase> {
  const now = options.now ?? Date.now;
  const jobs = interleave(options.cases, options.runs, options.variants);
  const records: (EvalRecord | undefined)[] = new Array(jobs.length);
  let next = 0;
  let inFlight = 0;
  let replied = false;
  let stopped: string | null = null;
  const worker = async () => {
    while (next < jobs.length && stopped === null) {
      if (!options.tally.canStart(inFlight)) {
        stopped = BUDGET_STOP_REASON;
        break;
      }
      const index = next;
      next += 1;
      const { evalCase, run, variant } = jobs[index];
      inFlight += 1;
      let turn: EvalTurn;
      try {
        turn = await options.runTurn(evalCase, variant.overrides);
      } finally {
        inFlight -= 1;
      }
      options.tally.addUsage(options.model, turn.usage);
      const record = evaluateTurnSafely(evalCase, run, turn);
      records[index] = record;
      if (!turn.error) replied = true;
      else if (!replied && isAuthError(turn.turnError)) stopped ??= AUTH_ABORT_REASON;
      if (turn.turnError?.outOfCredit) stopped ??= CREDIT_ABORT_REASON;
      options.onRecord?.(variant.name, record);
    }
  };
  const lanes = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_EXPERIMENT_CONCURRENCY, jobs.length),
  );
  await Promise.all(Array.from({ length: lanes }, worker));
  const generatedAt = new Date(now()).toISOString();
  const reports = Object.fromEntries(
    options.variants.map((variant) => [
      variant.name,
      buildReport(
        jobs.flatMap((job, index) => {
          const record = records[index];
          return job.variant === variant && record ? [record] : [];
        }),
        options.cases,
        {
          generatedAt,
          model: options.model.id,
          tactics: variant.overrides as TacticOverrides,
          runsPerCase: options.runs,
          aborted: stopped,
        },
      ),
    ]),
  );
  return {
    phase: options.phase,
    caseIds: options.cases.map((entry) => entry.id),
    runsPerCase: options.runs,
    reports,
    stopped,
  };
}

/** One held-out gate: the train winner it reran, and how it did there. */
export interface ExperimentGate {
  readonly variant: string;
  readonly phase: ExperimentPhase;
  readonly analysis: VariantAnalysis;
}

export interface ExperimentResult {
  readonly experiment: Experiment;
  readonly model: string;
  readonly generatedAt: string;
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly train: ExperimentPhase;
  /** Each variant against the control on train, in the experiment's order. */
  readonly trainAnalyses: readonly VariantAnalysis[];
  /** Every gate run, best train winner first, until one held. */
  readonly gates: readonly ExperimentGate[];
  readonly verdict: ExperimentVerdict;
  /** The variant that won on train and then on held-out; null otherwise. */
  readonly winner: ExperimentVariant | null;
  /** One line on why the verdict is what it is. */
  readonly reason: string;
  /** Why the experiment stopped before it finished, or null when it did not. */
  readonly stopped: string | null;
}

export interface RunExperimentOptions {
  readonly runTurn: ExperimentTurnRunner;
  readonly model?: AssistantModelProfile;
  readonly budgetUsd?: number;
  /** Runs per case on train; the experiment's own when absent. */
  readonly runs?: number;
  readonly gateRuns?: number;
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly onRecord?: (
    phase: ExperimentPhaseName,
    variant: string,
    record: EvalRecord,
  ) => void;
}

function analyses(
  experiment: Experiment,
  phase: ExperimentPhase,
  variants: readonly ExperimentVariant[],
): VariantAnalysis[] {
  const control = phase.reports[CONTROL];
  return variants
    .filter((variant) => variant.name !== CONTROL)
    .map((variant) =>
      analyzeVariant(
        variant,
        experiment.goal,
        control,
        phase.reports[variant.name],
        experiment.guardrails,
      ),
    );
}

/** The overall verdict and its reason, from what ran. */
function conclude(
  trainAnalyses: readonly VariantAnalysis[],
  gates: readonly ExperimentGate[],
  winner: ExperimentVariant | null,
  stopped: string | null,
): { verdict: ExperimentVerdict; reason: string } {
  if (winner) {
    return {
      verdict: "win",
      reason: `\`${winner.name}\` won on train and held there on the held-out cases.`,
    };
  }
  if (stopped) return { verdict: "inconclusive", reason: `Unfinished: ${stopped}` };
  const failedGates = gates.filter((gate) => gate.analysis.verdict !== "win");
  if (failedGates.some((gate) => gate.analysis.verdict === "inconclusive")) {
    return {
      verdict: "inconclusive",
      reason: `${failedGates.map((gate) => `\`${gate.variant}\``).join(", ")} won on train but not clearly on the held-out cases.`,
    };
  }
  if (trainAnalyses.some((analysis) => analysis.verdict === "inconclusive")) {
    return {
      verdict: "inconclusive",
      reason: "No variant won on train, and at least one was inconclusive there.",
    };
  }
  return {
    verdict: "no win",
    reason:
      failedGates.length > 0
        ? `${failedGates.map((gate) => `\`${gate.variant}\``).join(", ")} won on train and lost on the held-out cases.`
        : "No variant won on train.",
  };
}

/**
 * Runs an experiment end to end and returns its result. It never posts or
 * opens anything; {@link concludeExperiment} does that with what this returns.
 */
export async function runExperiment(
  experiment: Experiment,
  options: RunExperimentOptions,
): Promise<ExperimentResult> {
  const model = options.model ?? ASSISTANT_MODELS[ASSISTANT_MODEL_ID];
  const now = options.now ?? Date.now;
  const tally = new SpendTally(options.budgetUsd ?? DEFAULT_BUDGET_USD);
  const control = experiment.variants[0];
  const common = {
    runTurn: options.runTurn,
    model,
    tally,
    concurrency: options.concurrency,
    now,
  };
  const train = await runPhase({
    ...common,
    phase: "train",
    cases: experiment.train,
    runs: options.runs ?? experiment.runs,
    variants: experiment.variants,
    onRecord: (variant, record) => options.onRecord?.("train", variant, record),
  });
  const trainAnalyses = analyses(experiment, train, experiment.variants);
  const gates: ExperimentGate[] = [];
  let winner: ExperimentVariant | null = null;
  let stopped = train.stopped;
  const candidates = trainAnalyses
    .filter((analysis) => analysis.verdict === "win")
    .sort((a, b) => improvement(b) - improvement(a));
  for (const candidate of stopped ? [] : candidates) {
    const variant = experiment.variants.find((entry) => entry.name === candidate.variant);
    if (!variant) continue;
    const phase = await runPhase({
      ...common,
      phase: "gate",
      cases: experiment.heldout,
      runs: options.gateRuns ?? GATE_RUNS_PER_CASE,
      variants: [control, variant],
      onRecord: (name, record) => options.onRecord?.("gate", name, record),
    });
    const [analysis] = analyses(experiment, phase, [control, variant]);
    gates.push({ variant: variant.name, phase, analysis });
    if (phase.stopped) {
      stopped = phase.stopped;
      break;
    }
    if (analysis.verdict === "win") {
      winner = variant;
      break;
    }
  }
  const { verdict, reason } = conclude(trainAnalyses, gates, winner, stopped);
  return {
    experiment,
    model: model.id,
    generatedAt: new Date(now()).toISOString(),
    budgetUsd: tally.budgetUsd,
    spentUsd: tally.spentUsd,
    train,
    trainAnalyses,
    gates,
    verdict,
    winner,
    reason,
    stopped,
  };
}

/** Every turn the experiment ran, every phase and variant. */
export function experimentRecords(result: ExperimentResult): EvalRecord[] {
  return [result.train, ...result.gates.map((gate) => gate.phase)].flatMap((phase) =>
    Object.values(phase.reports).flatMap((report) => [...report.records]),
  );
}

/**
 * The script's exit status: 1 when the provider refused the key or the
 * account ran out of credit, or every turn errored, since then the verdict
 * says nothing; 0 otherwise, whatever the verdict.
 */
export function experimentExitCode(result: ExperimentResult): 0 | 1 {
  if (result.stopped && result.stopped !== BUDGET_STOP_REASON) return 1;
  const records = experimentRecords(result);
  if (records.length > 0 && records.every((record) => record.error)) return 1;
  return 0;
}
