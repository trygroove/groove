/**
 * The argument parsing of `bun run assistant:experiment` (GRV-110), kept
 * apart from `scripts/assistant-experiment.ts` so it is tested without
 * running anything. The script hands in `argv` and the environment; the
 * **Assistant experiments** workflow passes its inputs through the
 * environment (`EXPERIMENT_ID`, `EXPERIMENT_BUDGET`, `EXPERIMENT_RUNS`),
 * never into the script's text.
 *
 * The budget is the command's `--budget` (or `EXPERIMENT_BUDGET`) when one is
 * given, else the experiment file's own `budget`, else $25
 * ({@link resolveBudget}); a blank `EXPERIMENT_BUDGET`, which is what the
 * workflow passes when its input is left empty, is not given.
 */
import { ASSISTANT_MODEL_ID, ASSISTANT_MODELS, type AssistantModelId } from "../config";
import { EvalUsageError } from "./cli";
import { DEFAULT_BUDGET_USD, DEFAULT_EXPERIMENT_CONCURRENCY } from "./experimentRun";
import { DEFAULT_TURN_TIMEOUT_MS } from "./run";

export interface ExperimentCliOptions {
  readonly id: string;
  /** `--budget` or `EXPERIMENT_BUDGET`; null when neither is given. */
  readonly budgetUsd: number | null;
  /** Runs per case on train; null for the experiment's own. */
  readonly runs: number | null;
  readonly model: AssistantModelId;
  readonly concurrency: number;
  readonly turnTimeoutMs: number;
  readonly out: string | null;
  /** Post no comment and open no PR: the report is written and printed only. */
  readonly noPost: boolean;
}

export type ParsedExperimentArgs =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "run"; readonly options: ExperimentCliOptions };

export const EXPERIMENT_USAGE =
  "Usage: bun run assistant:experiment -- <experiment-id> [--budget USD (default: the experiment's, else 25)] [--runs N] [--model ID] [--concurrency N] [--timeout SECONDS] [--out DIR] [--no-post]";

function positive(value: number, option: string, whole: boolean): number {
  if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
    throw new EvalUsageError(
      `${option} must be ${whole ? "a whole number of at least 1" : "more than 0"}`,
    );
  }
  return value;
}

/** A value from the environment, or null when it is unset or blank. */
function fromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function parseExperimentArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ParsedExperimentArgs {
  let id = fromEnv(env, "EXPERIMENT_ID");
  let budget = fromEnv(env, "EXPERIMENT_BUDGET");
  let runs = fromEnv(env, "EXPERIMENT_RUNS");
  let model: string = ASSISTANT_MODEL_ID;
  let concurrency = String(DEFAULT_EXPERIMENT_CONCURRENCY);
  let timeout = String(DEFAULT_TURN_TIMEOUT_MS / 1000);
  let out: string | null = null;
  let noPost = false;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new EvalUsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--budget") budget = value();
    else if (arg === "--runs") runs = value();
    else if (arg === "--model") model = value();
    else if (arg === "--concurrency") concurrency = value();
    else if (arg === "--timeout") timeout = value();
    else if (arg === "--out") out = value();
    else if (arg === "--no-post") noPost = true;
    else if (arg === "--help" || arg === "-h")
      return { kind: "help", text: EXPERIMENT_USAGE };
    else if (arg.startsWith("--")) throw new EvalUsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) {
    throw new EvalUsageError(
      `Run one experiment at a time, not ${positional.join(", ")}`,
    );
  }
  id = positional[0] ?? id;
  if (!id) throw new EvalUsageError(`Name the experiment to run.\n\n${EXPERIMENT_USAGE}`);
  if (!(model in ASSISTANT_MODELS)) {
    throw new EvalUsageError(
      `Unknown model "${model}". Configured: ${Object.keys(ASSISTANT_MODELS).join(", ")}`,
    );
  }
  return {
    kind: "run",
    options: {
      id,
      budgetUsd: budget === null ? null : positive(Number(budget), "--budget", false),
      runs: runs === null ? null : positive(Number(runs), "--runs", true),
      model: model as AssistantModelId,
      concurrency: positive(Number(concurrency), "--concurrency", true),
      turnTimeoutMs: positive(Number(timeout), "--timeout", true) * 1000,
      out,
      noPost,
    },
  };
}

/**
 * The dollars an experiment may spend: the command's when given, else the
 * file's `budget`, else {@link DEFAULT_BUDGET_USD}.
 */
export function resolveBudget(
  given: number | null,
  experiment: { readonly budgetUsd: number | null },
): number {
  return given ?? experiment.budgetUsd ?? DEFAULT_BUDGET_USD;
}
