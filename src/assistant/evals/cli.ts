/**
 * The argument parsing and the API-key guard of `bun run assistant:eval`
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
import { DEFAULT_TURN_TIMEOUT_MS, type EvalRecord } from "./run";
import { type Scorecard, type ScorecardSource, scorecardOf } from "./scorecard";
import type { BaselineLabel } from "./scorecardMarkdown";
import { caseSet, EVAL_SETS, type EvalSetId } from "./sets";

export interface EvalCliOptions {
  readonly caseIds: string[];
  /** Only the cases of this set (GRV-119), or every set when null. */
  readonly set: EvalSetId | null;
  readonly runs: number;
  readonly model: AssistantModelId;
  readonly out: string | null;
  readonly replay: string | null;
  /** A saved `report.json` or `summary.json` to print the scorecard against. */
  readonly baseline: string | null;
  /** A kept turn the admin viewer downloaded, run as the one case (GRV-98). */
  readonly fromTranscript: string | null;
  readonly concurrency: number;
  /** Per-turn limit, retries included. */
  readonly turnTimeoutMs: number;
  /** The most steps a turn may take (`steps.ts`); null for production's. */
  readonly maxSteps: number | null;
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

export const EVAL_USAGE = `Usage: bun run assistant:eval -- [case ...] [--set ${EVAL_SETS.join("|")}] [--runs N] [--model ID] [--out DIR] [--replay REPORT] [--from-transcript FILE] [--baseline REPORT] [--concurrency N] [--timeout SECONDS] [--steps N]`;

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
  let set: string | null = null;
  let runs = Number(env.EVAL_RUNS ?? 3);
  let model: string = ASSISTANT_MODEL_ID;
  let out: string | null = null;
  let replay: string | null = null;
  let baseline: string | null = null;
  let fromTranscript: string | null = null;
  let concurrency = 3;
  let timeoutSeconds = DEFAULT_TURN_TIMEOUT_SECONDS;
  let maxSteps: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new EvalUsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--runs") runs = Number(value());
    else if (arg === "--set") set = value();
    else if (arg === "--model") model = value();
    else if (arg === "--out") out = value();
    else if (arg === "--replay") replay = value();
    else if (arg === "--baseline") baseline = value();
    else if (arg === "--from-transcript") fromTranscript = value();
    else if (arg === "--concurrency") concurrency = Number(value());
    else if (arg === "--timeout") timeoutSeconds = Number(value());
    else if (arg === "--steps") maxSteps = wholeNumber(Number(value()), "--steps");
    else if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: `${EVAL_USAGE}\n\nCases: ${caseList(EVAL_CASES)}` };
    } else if (arg.startsWith("--")) throw new EvalUsageError(`Unknown option ${arg}`);
    else caseIds.push(arg);
  }
  wholeNumber(runs, "--runs");
  wholeNumber(concurrency, "--concurrency");
  wholeNumber(timeoutSeconds, "--timeout");
  if (fromTranscript !== null && (replay !== null || caseIds.length > 0)) {
    throw new EvalUsageError(
      "--from-transcript runs the transcript's case alone: drop --replay and the case names",
    );
  }
  if (set !== null && !(EVAL_SETS as readonly string[]).includes(set)) {
    throw new EvalUsageError(`Unknown set "${set}". Sets: ${EVAL_SETS.join(", ")}`);
  }
  if (!(model in ASSISTANT_MODELS)) {
    throw new EvalUsageError(
      `Unknown model "${model}". Configured: ${Object.keys(ASSISTANT_MODELS).join(", ")}`,
    );
  }
  return {
    kind: "run",
    options: {
      caseIds,
      set: set as EvalSetId | null,
      runs,
      model: model as AssistantModelId,
      out,
      replay,
      baseline,
      fromTranscript,
      concurrency,
      turnTimeoutMs: timeoutSeconds * 1000,
      maxSteps,
    },
  };
}

/**
 * The named cases in the order given, or every case when none is named; with
 * a set, only that set's cases.
 */
export function selectEvalCases(
  ids: readonly string[],
  all: readonly EvalCase[] = EVAL_CASES,
  set: EvalSetId | null = null,
): EvalCase[] {
  const cases = set === null ? all : all.filter((entry) => caseSet(entry) === set);
  if (ids.length === 0) return [...cases];
  return ids.map((id) => {
    const found = cases.find((entry) => entry.id === id);
    if (!found)
      throw new EvalUsageError(`No eval case "${id}". Cases: ${caseList(cases)}`);
    return found;
  });
}

/** The API key from the environment, or an error saying no model was called. */
export function requireApiKey(
  env: Readonly<Record<string, string | undefined>>,
  tool: { readonly name: string; readonly example: string } = {
    name: "The assistant evals",
    example: "bun run assistant:eval",
  },
): string {
  const apiKey = env[ASSISTANT_API_KEY_SECRET]?.trim();
  if (!apiKey) {
    throw new EvalUsageError(
      `${ASSISTANT_API_KEY_SECRET} is not set (or is empty). ${tool.name} run against the live model and need an API key in the environment, e.g.\n\n  ${ASSISTANT_API_KEY_SECRET}=sk-ant-... ${tool.example}\n\nNo model was called.`,
    );
  }
  return apiKey;
}

/** A baseline read back: who it was, and its scorecard. */
export interface LoadedBaseline {
  readonly label: BaselineLabel;
  readonly scorecard: Scorecard;
}

/**
 * The scorecard of a saved report. A full `report.json` is scored afresh from
 * its records and check tallies, so one saved before the scorecard existed
 * still compares (its missing numbers as n/a); a `summary.json` (no records,
 * as `docs/assistant-eval-baseline.json` is) brings its scorecard with it.
 */
export function loadBaseline(saved: unknown, path: string): LoadedBaseline {
  const report = saved as Partial<ScorecardSource> & {
    generatedAt?: string;
    promptVersion?: string;
    scorecard?: Scorecard;
  };
  if (
    typeof report !== "object" ||
    report === null ||
    typeof report.model !== "string" ||
    !report.summary?.checks
  ) {
    throw new EvalUsageError(`${path} is not an eval report.json or summary.json`);
  }
  const label: BaselineLabel = {
    path,
    generatedAt: report.generatedAt ?? "unknown",
    model: report.model,
    promptVersion: report.promptVersion ?? "unknown",
  };
  if (Array.isArray(report.records)) {
    return {
      label,
      scorecard: scorecardOf({
        model: report.model,
        caseIds: report.caseIds ?? [
          ...new Set((report.records as EvalRecord[]).map((record) => record.caseId)),
        ],
        records: report.records,
        summary: report.summary,
      }),
    };
  }
  if (!report.scorecard) {
    throw new EvalUsageError(
      `${path} has neither records nor a scorecard to compare with`,
    );
  }
  return { label, scorecard: report.scorecard };
}
