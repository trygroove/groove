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
 * - **Cuts** (section 5a). A `cut` variant runs on train beside the rest;
 *   each that keeps there reruns, all of them in one pass beside the
 *   control, on the held-out cases. When more than one keeps on both, they
 *   run once more **together** as {@link COMBINED_CUTS}, on train and on
 *   held-out, since cuts fine alone can hurt together. If the combination
 *   fails, the cut with the worst goal number is dropped and the rest retried,
 *   at most twice; a combination that never holds keeps none of them.
 * - **A focus** (GRV-145). The goal is read from the experiment's focus cases
 *   alone; when none of them is held out, every held-out phase is judged on
 *   the guardrails alone ({@link judgedOnGuardrailsAlone}).
 * - **The verdict.** `win` when there is something to land: an improve that
 *   won on train and on held-out, or cuts that kept together (the held PR
 *   applies both). Otherwise the improves' `no win` or `inconclusive`.
 * - **Check 6.** An experiment that holds check 6 also runs its check-6
 *   block (`Experiment.flattening`) in every phase, the extreme cases of the
 *   phase's split beside their conventional partners, interleaved with the
 *   rest. Those turns make a report of their own per variant, which only the
 *   check-6 guardrail reads: the goal and every other guardrail see the
 *   phase's own cases alone, as in an experiment without it.
 * - **The budget.** Spend is the sum of every finished turn's cost from its
 *   usage and the model's price (`budget.ts`). No turn starts that would be
 *   expected to take it past the budget, and an experiment stopped short
 *   reports what it has, its verdict `inconclusive` unless a winner was
 *   found first, and every cut not yet proven `restore`.
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
  assertRunnable,
  COMBINED_CUTS,
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
  describeTurnError,
  type EvalRecord,
  type EvalReport,
  type EvalTurn,
  type EvalTurnError,
  evaluateTurnSafely,
  isAuthError,
  runCaseTurn,
} from "./run";
import type { EvalSplit } from "./splits";
import {
  analyzeVariant,
  type CutVerdict,
  type ExperimentVerdict,
  GOAL_METRICS,
  improvement,
  type VariantAnalysis,
} from "./verdict";

export const DEFAULT_EXPERIMENT_CONCURRENCY = 10;

export const DEFAULT_BUDGET_USD = 25;

export const BUDGET_STOP_REASON =
  "The experiment reached its budget, so no further turns were run.";

/** How many times a failed combination of cuts is retried, a cut fewer each time. */
export const COMBINED_CUT_RETRIES = 2;

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

/**
 * What a phase is: the train pass, an improve's held-out gate, the cuts'
 * held-out gate, or one combination of cuts on train or on held-out.
 */
export type ExperimentPhaseName =
  | "train"
  | "gate"
  | "cut-gate"
  | "combined-train"
  | "combined-gate";

/** One phase: which cases ran how often, and each variant's report. */
export interface ExperimentPhase {
  readonly phase: ExperimentPhaseName;
  /** Unique within the experiment, e.g. `gate-terse`: where its reports are written. */
  readonly label: string;
  readonly caseIds: readonly string[];
  readonly runsPerCase: number;
  /** Each variant's report, by name, the control's first. */
  readonly reports: Readonly<Record<string, EvalReport>>;
  /**
   * The check-6 block's cases and each variant's report on them, which only
   * the check-6 guardrail reads; null when the experiment does not hold it.
   */
  readonly flattening: {
    readonly caseIds: readonly string[];
    readonly reports: Readonly<Record<string, EvalReport>>;
  } | null;
  /** Why it stopped before every turn ran, or null when it did not. */
  readonly stopped: string | null;
}

export interface PhaseOptions {
  readonly phase: ExperimentPhaseName;
  /** Unique within the experiment; the phase's name when absent. */
  readonly label?: string;
  readonly cases: readonly EvalCase[];
  /**
   * The check-6 block run beside `cases` (a case in both runs once), judged
   * on its own; none when absent or empty.
   */
  readonly flattening?: readonly EvalCase[];
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

/** The split each phase runs on, which picks its check-6 block. */
const PHASE_SPLITS: Readonly<Record<ExperimentPhaseName, EvalSplit>> = {
  train: "train",
  "combined-train": "train",
  gate: "heldout",
  "cut-gate": "heldout",
  "combined-gate": "heldout",
};

/**
 * One turn, a throw included: a turn runner that throws gives an errored
 * record like any failed turn, rather than ending the whole phase.
 */
async function safeTurn(
  runTurn: ExperimentTurnRunner,
  evalCase: EvalCase,
  tactics: VariantTactics,
): Promise<EvalTurn> {
  try {
    return await runTurn(evalCase, tactics);
  } catch (error) {
    const turnError: EvalTurnError = {
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
      providerStatus: null,
      providerFailures: [],
    };
    return {
      durationMs: 0,
      error: describeTurnError(turnError),
      turnError,
      stopReason: null,
      text: "",
      proposal: null,
      usage: null,
    };
  }
}

/** Runs one phase, every variant in one interleaved pass, inside the budget. */
export async function runPhase(options: PhaseOptions): Promise<ExperimentPhase> {
  const now = options.now ?? Date.now;
  const block = options.flattening ?? [];
  const extra = block.filter((entry) => !options.cases.includes(entry));
  const jobs = interleave([...options.cases, ...extra], options.runs, options.variants);
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
      const turn = await safeTurn(options.runTurn, evalCase, variant.overrides);
      inFlight -= 1;
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
  const reportsOn = (cases: readonly EvalCase[]) =>
    Object.fromEntries(
      options.variants.map((variant) => [
        variant.name,
        buildReport(
          jobs.flatMap((job, index) => {
            const record = records[index];
            return job.variant === variant && record && cases.includes(job.evalCase)
              ? [record]
              : [];
          }),
          cases,
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
    label: options.label ?? options.phase,
    caseIds: options.cases.map((entry) => entry.id),
    runsPerCase: options.runs,
    reports: reportsOn(options.cases),
    flattening:
      block.length === 0
        ? null
        : { caseIds: block.map((entry) => entry.id), reports: reportsOn(block) },
    stopped,
  };
}

/** One held-out gate: the train winner it reran, and how it did there. */
export interface ExperimentGate {
  readonly variant: string;
  readonly phase: ExperimentPhase;
  readonly analysis: VariantAnalysis;
}

/** The cuts that kept on train, rerun beside the control on held-out. */
export interface CutGate {
  readonly phase: ExperimentPhase;
  readonly analyses: readonly VariantAnalysis[];
}

/** One run of the passing cuts together, on train and (if it held there) on held-out. */
export interface CombinedCutRun {
  /** The cuts it combined, in the experiment's order. */
  readonly cuts: readonly string[];
  readonly variant: ExperimentVariant;
  readonly train: ExperimentGate;
  readonly heldout: ExperimentGate | null;
  /** Whether it kept on both. */
  readonly held: boolean;
}

/** A cut's final verdict, after its own runs and the combined ones. */
export interface CutOutcome {
  readonly name: string;
  readonly verdict: CutVerdict;
  readonly why: string;
}

export interface ExperimentResult {
  readonly experiment: Experiment;
  readonly model: string;
  readonly generatedAt: string;
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly train: ExperimentPhase;
  /** Each variant against the control on train, in the experiment's order, cuts included. */
  readonly trainAnalyses: readonly VariantAnalysis[];
  /** Every improve gate run, best train winner first, until one held. */
  readonly gates: readonly ExperimentGate[];
  /** The cuts' held-out run; null when no cut kept on train, or there are none. */
  readonly cutGate: CutGate | null;
  /** Every run of the passing cuts together, in order. */
  readonly combined: readonly CombinedCutRun[];
  /** Every cut's final verdict, in the experiment's order. */
  readonly cuts: readonly CutOutcome[];
  /** The cuts the held PR applies: those that kept, together. */
  readonly keptCuts: readonly ExperimentVariant[];
  readonly verdict: ExperimentVerdict;
  /** The improve that won on train and then on held-out; null otherwise. */
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
  /** Each finished turn, with its phase's label (`train`, `gate-terse`, ...). */
  readonly onRecord?: (phase: string, variant: string, record: EvalRecord) => void;
}

/** The phases run on the held-out cases. */
const HELDOUT_PHASES: ReadonlySet<ExperimentPhaseName> = new Set([
  "gate",
  "cut-gate",
  "combined-gate",
]);

/**
 * Whether a phase is judged on the guardrails alone (GRV-145): a held-out
 * phase of an experiment whose focus cases are all train cases, so there is
 * no goal to read there; the held-out cases then only show the variant costs
 * nothing elsewhere.
 */
export function judgedOnGuardrailsAlone(
  experiment: Experiment,
  phase: ExperimentPhaseName,
): boolean {
  const { focus } = experiment;
  if (!focus || !HELDOUT_PHASES.has(phase)) return false;
  return !experiment.heldout.some((entry) => focus.includes(entry.id));
}

function analyses(
  experiment: Experiment,
  phase: ExperimentPhase,
  variants: readonly ExperimentVariant[],
): VariantAnalysis[] {
  const control = phase.reports[CONTROL];
  const block = phase.flattening?.reports;
  const options = {
    focus: experiment.focus,
    guardrailsOnly: judgedOnGuardrailsAlone(experiment, phase.phase),
  };
  return variants
    .filter((variant) => variant.name !== CONTROL)
    .map((variant) =>
      analyzeVariant(
        variant,
        experiment.goal,
        control,
        phase.reports[variant.name],
        experiment.guardrails,
        {
          ...options,
          flattening: block
            ? { control: block[CONTROL], variant: block[variant.name] }
            : null,
        },
      ),
    );
}

function names(variants: readonly { readonly name: string }[]): string {
  return variants.map((variant) => `\`${variant.name}\``).join(", ");
}

/** What the improves say on their own, from what ran. */
function concludeImproves(
  improves: readonly VariantAnalysis[],
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
  if (improves.length === 0) {
    return { verdict: "no win", reason: "No cut kept, and there is no improve variant." };
  }
  const failedGates = gates.filter((gate) => gate.analysis.verdict !== "win");
  if (failedGates.some((gate) => gate.analysis.verdict === "inconclusive")) {
    return {
      verdict: "inconclusive",
      reason: `${names(failedGates.map((gate) => ({ name: gate.variant })))} won on train but not clearly on the held-out cases.`,
    };
  }
  if (improves.some((analysis) => analysis.verdict === "inconclusive")) {
    return {
      verdict: "inconclusive",
      reason: "No variant won on train, and at least one was inconclusive there.",
    };
  }
  return {
    verdict: "no win",
    reason:
      failedGates.length > 0
        ? `${names(failedGates.map((gate) => ({ name: gate.variant })))} won on train and lost on the held-out cases.`
        : "No variant won on train.",
  };
}

/** The overall verdict: a win when an improve won or cuts kept, else the improves'. */
function conclude(
  improves: readonly VariantAnalysis[],
  gates: readonly ExperimentGate[],
  winner: ExperimentVariant | null,
  keptCuts: readonly ExperimentVariant[],
  stopped: string | null,
): { verdict: ExperimentVerdict; reason: string } {
  const own = concludeImproves(improves, gates, winner, stopped);
  if (keptCuts.length === 0) return own;
  const kept = `${keptCuts.length === 1 ? "the cut" : "the cuts"} ${names(keptCuts)} kept${keptCuts.length > 1 ? ", together" : ""}`;
  if (winner) return { verdict: "win", reason: `${own.reason} And ${kept}.` };
  return {
    verdict: "win",
    reason: `${kept.charAt(0).toUpperCase()}${kept.slice(1)}; ${improves.length === 0 ? "there is no improve variant." : `no improve won (${own.verdict}): ${own.reason}`}`,
  };
}

/** Several cuts' values as one variant: each sets tactics the others do not. */
function combinedVariant(cuts: readonly ExperimentVariant[]): ExperimentVariant {
  return {
    name: COMBINED_CUTS,
    kind: "cut",
    overrides: Object.assign({}, ...cuts.map((cut) => cut.overrides)),
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
  assertRunnable(experiment);
  const model = options.model ?? ASSISTANT_MODELS[ASSISTANT_MODEL_ID];
  const now = options.now ?? Date.now;
  const tally = new SpendTally(options.budgetUsd ?? DEFAULT_BUDGET_USD);
  const control = experiment.variants[0];
  const gateRuns = options.gateRuns ?? GATE_RUNS_PER_CASE;
  const phase = (
    name: ExperimentPhaseName,
    label: string,
    cases: readonly EvalCase[],
    runs: number,
    variants: readonly ExperimentVariant[],
  ) =>
    runPhase({
      runTurn: options.runTurn,
      model,
      tally,
      concurrency: options.concurrency,
      now,
      phase: name,
      label,
      cases,
      flattening: experiment.flattening[PHASE_SPLITS[name]],
      runs,
      variants,
      onRecord: (variant, record) => options.onRecord?.(label, variant, record),
    });
  /** One variant beside the control, on train or held-out, judged. */
  const judged = async (
    name: ExperimentPhaseName,
    label: string,
    cases: readonly EvalCase[],
    runs: number,
    variant: ExperimentVariant,
  ): Promise<ExperimentGate> => {
    const ran = await phase(name, label, cases, runs, [control, variant]);
    const [analysis] = analyses(experiment, ran, [control, variant]);
    return { variant: variant.name, phase: ran, analysis };
  };

  const train = await phase(
    "train",
    "train",
    experiment.train,
    options.runs ?? experiment.runs,
    experiment.variants,
  );
  const trainAnalyses = analyses(experiment, train, experiment.variants);
  let stopped = train.stopped;

  // Improves: each train winner, best first, through the held-out gate.
  const gates: ExperimentGate[] = [];
  let winner: ExperimentVariant | null = null;
  const improves = trainAnalyses.filter((analysis) => analysis.kind === "improve");
  const candidates = improves
    .filter((analysis) => analysis.verdict === "win")
    .sort((a, b) => improvement(b) - improvement(a));
  for (const candidate of candidates) {
    if (stopped) break;
    const variant = experiment.variants.find((entry) => entry.name === candidate.variant);
    if (!variant) continue;
    const gate = await judged(
      "gate",
      `gate-${variant.name}`,
      experiment.heldout,
      gateRuns,
      variant,
    );
    gates.push(gate);
    stopped = gate.phase.stopped;
    if (stopped) break;
    if (gate.analysis.verdict === "win") {
      winner = variant;
      break;
    }
  }

  // Cuts: every one that kept on train, in one pass on held-out.
  const cutVariants = experiment.variants.filter((variant) => variant.kind === "cut");
  const outcomes = new Map<string, CutOutcome>();
  const restore = (name: string, why: string) =>
    outcomes.set(name, { name, verdict: "restore", why });
  // A train pass cut short proves nothing either way: the stop below says so.
  for (const analysis of trainAnalyses.filter((entry) => entry.kind === "cut")) {
    if (!train.stopped && analysis.verdict !== "keep") {
      restore(analysis.variant, `On train: ${analysis.why}`);
    }
  }
  const trainKept = cutVariants.filter((cut) => !outcomes.has(cut.name));
  let cutGate: CutGate | null = null;
  let passing: ExperimentVariant[] = [];
  if (trainKept.length > 0 && !stopped) {
    const ran = await phase("cut-gate", "cut-gate", experiment.heldout, gateRuns, [
      control,
      ...trainKept,
    ]);
    cutGate = {
      phase: ran,
      analyses: analyses(experiment, ran, [control, ...trainKept]),
    };
    stopped = ran.stopped;
    if (!stopped) {
      for (const analysis of cutGate.analyses) {
        if (analysis.verdict !== "keep") {
          restore(analysis.variant, `Held on train, not on held-out: ${analysis.why}`);
        }
      }
      passing = trainKept.filter((cut) => !outcomes.has(cut.name));
    }
  }

  // The cuts that passed alone, together; the worst dropped on each failure.
  const combined: CombinedCutRun[] = [];
  const goalOf = new Map(trainAnalyses.map((analysis) => [analysis.variant, analysis]));
  while (passing.length > 1 && !stopped) {
    const variant = combinedVariant(passing);
    const attempt = combined.length + 1;
    const onTrain = await judged(
      "combined-train",
      `combined-${attempt}-train`,
      experiment.train,
      options.runs ?? experiment.runs,
      variant,
    );
    stopped = onTrain.phase.stopped;
    const onHeldout =
      !stopped && onTrain.analysis.verdict === "keep"
        ? await judged(
            "combined-gate",
            `combined-${attempt}-gate`,
            experiment.heldout,
            gateRuns,
            variant,
          )
        : null;
    stopped ??= onHeldout?.phase.stopped ?? null;
    const held =
      !stopped &&
      onTrain.analysis.verdict === "keep" &&
      onHeldout?.analysis.verdict === "keep";
    combined.push({
      cuts: passing.map((cut) => cut.name),
      variant,
      train: onTrain,
      heldout: onHeldout,
      held,
    });
    if (held || stopped) break;
    if (attempt > COMBINED_CUT_RETRIES) {
      for (const cut of passing) {
        restore(
          cut.name,
          `Kept alone, but the cuts never held together in ${attempt} combined runs.`,
        );
      }
      passing = [];
      break;
    }
    const worst = [...passing].sort(
      (a, b) =>
        improvement(goalOf.get(a.name) as VariantAnalysis) -
        improvement(goalOf.get(b.name) as VariantAnalysis),
    )[0];
    restore(
      worst.name,
      `Kept alone, but the cuts failed together in combined run ${attempt}, and it had the worst ${goalLabel(experiment)} of them on train, so it was dropped.`,
    );
    passing = passing.filter((cut) => cut !== worst);
  }
  if (stopped) {
    for (const cut of cutVariants) {
      if (!outcomes.has(cut.name)) {
        restore(cut.name, `Unfinished before it was proven: ${stopped}`);
      }
    }
    passing = [];
  }
  const keptCuts = passing;
  for (const cut of keptCuts) {
    outcomes.set(cut.name, {
      name: cut.name,
      verdict: "keep",
      why:
        keptCuts.length > 1
          ? "Held the bar on train and held-out, alone and with the other kept cuts."
          : "Held the bar on train and held-out.",
    });
  }
  const cuts = cutVariants.map((cut) => outcomes.get(cut.name) as CutOutcome);

  const { verdict, reason } = conclude(improves, gates, winner, keptCuts, stopped);
  return {
    experiment,
    model: model.id,
    generatedAt: new Date(now()).toISOString(),
    budgetUsd: tally.budgetUsd,
    spentUsd: tally.spentUsd,
    train,
    trainAnalyses,
    gates,
    cutGate,
    combined,
    cuts,
    keptCuts,
    verdict,
    winner,
    reason,
    stopped,
  };
}

function goalLabel(experiment: Experiment): string {
  return GOAL_METRICS[experiment.goal].label.toLowerCase();
}

/** Every phase the experiment ran, in order. */
export function experimentPhases(result: ExperimentResult): ExperimentPhase[] {
  return [
    result.train,
    ...result.gates.map((gate) => gate.phase),
    ...(result.cutGate ? [result.cutGate.phase] : []),
    ...result.combined.flatMap((run) => [
      run.train.phase,
      ...(run.heldout ? [run.heldout.phase] : []),
    ]),
  ];
}

/** Every turn the experiment ran, every phase and variant. */
export function experimentRecords(result: ExperimentResult): EvalRecord[] {
  return experimentPhases(result).flatMap((phase) =>
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
