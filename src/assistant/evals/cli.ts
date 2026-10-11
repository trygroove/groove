/**
 * The argument parsing and the API-key guard of `bun run eval:assistant`
 * (GRV-6), kept apart from `scripts/eval-assistant.ts` so they are tested
 * without running the script. Nothing here reads `process` or calls a model:
 * the script hands in `argv` and the environment, and turns an
 * {@link EvalUsageError} into its message and exit status.
 */
import {
  ASSISTANT_API_KEY_SECRET,
  ASSISTANT_MODEL_ID,
  ASSISTANT_MODELS,
  type AssistantModelId,
} from "../config";
import { EVAL_CASES, type EvalCase } from "./cases";
import { DEFAULT_TURN_TIMEOUT_MS } from "./run";

export interface EvalCliOptions {
  readonly caseIds: string[];
  readonly runs: number;
  readonly model: AssistantModelId;
  readonly out: string | null;
  readonly replay: string | null;
  readonly concurrency: number;
  /** Per-turn limit, retries included. */
  readonly turnTimeoutMs: number;
}

export type ParsedEvalArgs =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "run"; readonly options: EvalCliOptions };

/** A usage mistake or a missing key: the script prints it and exits 1. */
export class EvalUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalUsageError";
  }
}

export const EVAL_USAGE =
  "Usage: bun run eval:assistant -- [case ...] [--runs N] [--model ID] [--out DIR] [--replay REPORT] [--concurrency N] [--timeout SECONDS]";

const DEFAULT_TURN_TIMEOUT_SECONDS = DEFAULT_TURN_TIMEOUT_MS / 1000;

function caseList(cases: readonly EvalCase[]): string {
  return cases.map((entry) => entry.id).join(", ");
}

function wholeNumber(value: number, option: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new EvalUsageError(`${option} must be a whole number of at least 1`);
  }
  return value;
}

export function parseEvalArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ParsedEvalArgs {
  const caseIds: string[] = [];
  let runs = Number(env.EVAL_RUNS ?? 3);
  let model: string = ASSISTANT_MODEL_ID;
  let out: string | null = null;
  let replay: string | null = null;
  let concurrency = 3;
  let timeoutSeconds = DEFAULT_TURN_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new EvalUsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--runs") runs = Number(value());
    else if (arg === "--model") model = value();
    else if (arg === "--out") out = value();
    else if (arg === "--replay") replay = value();
    else if (arg === "--concurrency") concurrency = Number(value());
    else if (arg === "--timeout") timeoutSeconds = Number(value());
    else if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: `${EVAL_USAGE}\n\nCases: ${caseList(EVAL_CASES)}` };
    } else if (arg.startsWith("--")) throw new EvalUsageError(`Unknown option ${arg}`);
    else caseIds.push(arg);
  }
  wholeNumber(runs, "--runs");
  wholeNumber(concurrency, "--concurrency");
  wholeNumber(timeoutSeconds, "--timeout");
  if (!(model in ASSISTANT_MODELS)) {
    throw new EvalUsageError(
      `Unknown model "${model}". Configured: ${Object.keys(ASSISTANT_MODELS).join(", ")}`,
    );
  }
  return {
    kind: "run",
    options: {
      caseIds,
      runs,
      model: model as AssistantModelId,
      out,
      replay,
      concurrency,
      turnTimeoutMs: timeoutSeconds * 1000,
    },
  };
}

/** The named cases in the order given, or every case when none is named. */
export function selectEvalCases(
  ids: readonly string[],
  cases: readonly EvalCase[] = EVAL_CASES,
): EvalCase[] {
  if (ids.length === 0) return [...cases];
  return ids.map((id) => {
    const found = cases.find((entry) => entry.id === id);
    if (!found)
      throw new EvalUsageError(`No eval case "${id}". Cases: ${caseList(cases)}`);
    return found;
  });
}

/** The API key from the environment, or an error saying no model was called. */
export function requireApiKey(env: Readonly<Record<string, string | undefined>>): string {
  const apiKey = env[ASSISTANT_API_KEY_SECRET]?.trim();
  if (!apiKey) {
    throw new EvalUsageError(
      `${ASSISTANT_API_KEY_SECRET} is not set (or is empty). The assistant evals run against the live model and need an API key in the environment, e.g.\n\n  ${ASSISTANT_API_KEY_SECRET}=sk-ant-... bun run eval:assistant\n\nNo model was called.`,
    );
  }
  return apiKey;
}
