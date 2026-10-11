/**
 * Running the assistant's musical evals (GRV-6).
 *
 * Each case runs N times through {@link runAssistantTurn}, the gateway's own
 * turn, so the model sees exactly what production sends it: the production
 * system prompt, the project context built by `buildAssistantPayload`, the
 * tool schema and the per-model request. Only the surroundings differ: the
 * caller is a fixed eval account, the guard stores are in memory (so nothing
 * touches Firestore or the deployed gateway's quota), and the provider is
 * whatever the caller hands in. `scripts/eval-assistant.ts` hands in the live
 * one; tests hand in a scripted one.
 *
 * Each turn's reply is kept whole (its text and its proposal), and every check
 * is judged from what was kept, so {@link evaluateRecords} can replay a saved
 * report's proposals against the current checks without calling anything.
 *
 * A turn that *errored* (the provider refused or failed, the transport broke,
 * the turn timed out, or judging it threw) is not the model's answer, so it is
 * judged by no check at all: it is counted apart, with the provider's failure
 * kinds and HTTP status, and never lowers a pass rate. A reply that came back
 * with no proposal is the model's answer, and fails check 1.
 */

import type { AssistantAsk } from "../ask";
import {
  ASSISTANT_CALL_LIMITS,
  ASSISTANT_MODEL_ID,
  ASSISTANT_MODELS,
  type AssistantModelProfile,
} from "../config";
import { type AssistantGatewayDeps, runAssistantTurn } from "../gateway";
import { createInMemoryGuardStores } from "../inMemoryGuardStores";
import { buildAssistantPayload } from "../payload";
import { ASSISTANT_PROMPT_VERSION } from "../prompt";
import {
  AssistantGatewayError,
  type AssistantProposal,
  type AssistantStopReason,
} from "../protocol";
import type { AssistantProvider } from "../provider";
import type { AssistantTurnLog } from "../telemetry";
import { ASSISTANT_TOOLSET_VERSION } from "../tools";
import { casePairs, type EvalCase, resolveScope, resolveSelection } from "./cases";
import {
  CHECK_IDS,
  type CheckId,
  type CheckResult,
  checkAtomicUndo,
  checkBundled,
  checkGrounded,
  checkInScope,
  checkNotFlattened,
  checkValid,
  proposalFingerprint,
  skip,
} from "./checks";
import { describeProposal, type ProposalStats } from "./describe";

/** Why a turn errored, as far as the gateway and the provider said. */
export interface EvalTurnError {
  /**
   * The gateway's error code (`provider_error`, `provider_unavailable`, ...),
   * `internal_error` for an unknown throw, `eval_timeout` when the turn ran
   * past the eval's own limit, or `eval_error` when judging it threw.
   */
  readonly code: string;
  readonly message: string;
  /** The last HTTP status a failed provider attempt carried, if any. */
  readonly providerStatus: number | null;
  /** Why each failed provider attempt failed, in order (`rejected`, `rate_limited`, ...). */
  readonly providerFailures: readonly string[];
}

/** What one turn came back with, or how it failed. */
export interface EvalTurn {
  readonly durationMs: number;
  /**
   * One line saying why the turn errored, provider status included; null when
   * it came back with a reply. An errored turn is judged by no check.
   */
  readonly error: string | null;
  /** The same failure, field by field. Absent from reports saved before it existed. */
  readonly turnError?: EvalTurnError | null;
  readonly stopReason: AssistantStopReason | null;
  readonly text: string;
  readonly proposal: AssistantProposal | null;
  /** The question the turn asked instead, if it asked one. Absent from older reports. */
  readonly ask?: AssistantAsk | null;
}

/** One run of one case: the request, everything the model returned, every check. */
export interface EvalRecord extends EvalTurn {
  readonly caseId: string;
  readonly capability: EvalCase["capability"];
  readonly axis: EvalCase["axis"];
  readonly request: string;
  /** 1-based. Check 6 compares across all of a pair's runs. */
  readonly run: number;
  /** Check 6 is only judged on an extreme case's records; an errored turn has none. */
  readonly checks: Partial<Record<CheckId, CheckResult>>;
  readonly stats: ProposalStats | null;
  /** The proposal with its fresh IDs normalised; null when it did not apply. */
  readonly fingerprint: string | null;
}

export type Tally = Record<CheckResult["status"], number>;

export interface EvalReport {
  readonly generatedAt: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly toolsetVersion: number;
  readonly runsPerCase: number;
  readonly caseIds: readonly string[];
  readonly records: readonly EvalRecord[];
  /** Why the run stopped before every turn ran, or null when it did not. */
  readonly aborted: string | null;
  readonly summary: {
    readonly checks: Record<CheckId, Tally>;
    readonly cases: Record<string, Partial<Record<CheckId, Tally>>>;
    /** Turns that errored and were judged by no check, overall and per case. */
    readonly errored: {
      readonly total: number;
      /** Of those, turns the provider refused for the API key (HTTP 401 or 403). */
      readonly auth: number;
      readonly cases: Record<string, number>;
    };
  };
}

/** The provider refused the API key: every other turn will be refused too. */
export function isAuthError(error: EvalTurnError | null | undefined): boolean {
  return error?.providerStatus === 401 || error?.providerStatus === 403;
}

/** One line for an errored turn: the code, our message, and what the provider said. */
export function describeTurnError(error: EvalTurnError): string {
  const provider = [
    error.providerFailures.length > 0 ? error.providerFailures.join(", ") : null,
    error.providerStatus === null ? null : `HTTP ${error.providerStatus}`,
  ].filter((part): part is string => part !== null);
  const auth = isAuthError(error) ? " The provider rejected the API key." : "";
  return `${error.code}: ${error.message}${provider.length > 0 ? ` (provider: ${provider.join(", ")})` : ""}${auth}`;
}

/**
 * The eval's own limit on one turn, retries included: production's, the Cloud
 * Function's ceiling. A full loop sketch streams for minutes, so a shorter
 * limit counts turns production would finish as errored.
 */
export const DEFAULT_TURN_TIMEOUT_MS =
  ASSISTANT_CALL_LIMITS.functionTimeoutSeconds * 1000;

/**
 * The in-memory guards' limits: high enough that a full run never trips them.
 * Production's quota and spend ceiling are for producers, and nothing here
 * counts against them.
 */
const EVAL_GUARD_LIMITS: NonNullable<AssistantGatewayDeps["guardLimits"]> = {
  requestsPerWindow: 100_000,
  windowMs: 24 * 60 * 60 * 1000,
  dailySpendCeilingUsd: 1_000,
};

const EVAL_CALLER = { uid: "assistant-evals", signInProvider: "password" } as const;

export interface RunTurnOptions {
  readonly provider: AssistantProvider;
  readonly model?: AssistantModelProfile;
  readonly now?: () => number;
  /** Aborts a turn that runs longer, as an errored turn. Default {@link DEFAULT_TURN_TIMEOUT_MS}. */
  readonly turnTimeoutMs?: number;
}

class EvalTimeout extends Error {}

/** Runs one case once through the gateway's own turn. Never throws for a failed turn. */
export async function runCaseTurn(
  evalCase: EvalCase,
  options: RunTurnOptions,
): Promise<EvalTurn> {
  const now = options.now ?? Date.now;
  const project = evalCase.fixture();
  const context = buildAssistantPayload(
    project,
    resolveSelection(project, evalCase.selection),
  );
  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const controller = new AbortController();
  let turnLog: AssistantTurnLog | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EvalTimeout());
    }, timeoutMs);
  });
  const startedAt = now();
  try {
    const result = await Promise.race([
      runAssistantTurn(
        {
          provider: options.provider,
          guards: createInMemoryGuardStores(),
          log: (record) => {
            turnLog = record;
          },
          now,
          model: options.model,
          guardLimits: EVAL_GUARD_LIMITS,
        },
        EVAL_CALLER,
        {
          projectRevision: project.metadata.revision,
          messages: [{ role: "user", text: evalCase.request }],
          context,
        },
        { signal: controller.signal, onChunk: () => {} },
      ),
      timedOut,
    ]);
    return {
      durationMs: now() - startedAt,
      error: null,
      turnError: null,
      stopReason: result.stopReason,
      text: result.text,
      proposal: result.proposal,
      ask: result.ask,
    };
  } catch (error) {
    const log = turnLog as AssistantTurnLog | null;
    const provider = {
      providerStatus: log?.providerStatus ?? null,
      providerFailures: log?.failures ?? [],
    };
    const turnError: EvalTurnError =
      error instanceof EvalTimeout || controller.signal.aborted
        ? {
            code: "eval_timeout",
            message: `The turn took longer than ${Math.round(timeoutMs / 1000)} s and was aborted.`,
            ...provider,
          }
        : error instanceof AssistantGatewayError
          ? { code: error.code, message: error.message, ...provider }
          : {
              code: "internal_error",
              message: error instanceof Error ? error.message : String(error),
              ...provider,
            };
    return erroredTurn(now() - startedAt, turnError);
  } finally {
    clearTimeout(timer);
  }
}

function erroredTurn(durationMs: number, turnError: EvalTurnError): EvalTurn {
  return {
    durationMs,
    error: describeTurnError(turnError),
    turnError,
    stopReason: null,
    text: "",
    proposal: null,
  };
}

/** Why a reply that came back proposed nothing, as far as the turn shows. */
export function whyNoProposal(turn: EvalTurn): string {
  if (turn.ask) return `It asked the producer instead: "${turn.ask.question}"`;
  if (turn.stopReason === "max_tokens") {
    return "The reply was cut off at max_tokens, so its tool calls were dropped";
  }
  if (turn.stopReason === "refusal") return "The model refused";
  if (turn.stopReason === "tool_use") return "The reply called only explain_change";
  return "The reply called no tool";
}

/**
 * Checks 1 to 5 on one turn, and its descriptive numbers. An errored turn is
 * judged by no check.
 */
export function evaluateTurn(
  evalCase: EvalCase,
  run: number,
  turn: EvalTurn,
): EvalRecord {
  const base = {
    ...turn,
    caseId: evalCase.id,
    capability: evalCase.capability,
    axis: evalCase.axis,
    request: evalCase.request,
    run,
  };
  if (turn.error) return { ...base, checks: {}, stats: null, fingerprint: null };
  const project = evalCase.fixture();
  const valid = checkValid(project, turn.proposal, whyNoProposal(turn));
  if (!valid.applied) {
    const notJudged = skip("The proposal did not apply");
    return {
      ...base,
      checks: {
        valid: valid.result,
        bundled: notJudged,
        inScope: notJudged,
        atomicUndo: notJudged,
        grounded: notJudged,
      },
      stats: null,
      fingerprint: null,
    };
  }
  const { proposal, after } = valid.applied;
  return {
    ...base,
    checks: {
      valid: valid.result,
      bundled: checkBundled(proposal.commands, after),
      inScope: checkInScope(project, after, resolveScope(project, evalCase.scope)),
      atomicUndo: checkAtomicUndo(project, turn.proposal),
      grounded: checkGrounded(project, after, proposal.impact.controls, turn.text),
    },
    stats: describeProposal(project, after, proposal.commands.length),
    fingerprint: proposalFingerprint(project, proposal.commands),
  };
}

/** Check 6 on every extreme record, against its pair's conventional records. */
export function judgeFlattening(
  records: readonly EvalRecord[],
  cases: readonly EvalCase[],
): EvalRecord[] {
  const conventionalOf = new Map(
    casePairs(cases).map((pair) => [pair.extreme.id, pair.conventional.id]),
  );
  return records.map((record) => {
    const conventionalId = conventionalOf.get(record.caseId);
    if (!conventionalId || record.error) return record;
    const conventional = records
      .filter((candidate) => candidate.caseId === conventionalId)
      .map((candidate) => candidate.fingerprint);
    return {
      ...record,
      checks: {
        ...record.checks,
        notFlattened: checkNotFlattened(record.fingerprint, conventional),
      },
    };
  });
}

function emptyTally(): Tally {
  return { pass: 0, fail: 0, skip: 0 };
}

export function summarize(records: readonly EvalRecord[]): EvalReport["summary"] {
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, emptyTally()])) as Record<
    CheckId,
    Tally
  >;
  const cases: Record<string, Partial<Record<CheckId, Tally>>> = {};
  const errored = { total: 0, auth: 0, cases: {} as Record<string, number> };
  for (const record of records) {
    const perCase = cases[record.caseId] ?? {};
    cases[record.caseId] = perCase;
    errored.cases[record.caseId] ??= 0;
    if (record.error) {
      errored.total += 1;
      errored.cases[record.caseId] += 1;
      if (isAuthError(record.turnError)) errored.auth += 1;
      continue;
    }
    for (const id of CHECK_IDS) {
      const result = record.checks[id];
      if (!result) continue;
      checks[id][result.status] += 1;
      const tally = perCase[id] ?? emptyTally();
      tally[result.status] += 1;
      perCase[id] = tally;
    }
  }
  return { checks, cases, errored };
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly toolsetVersion?: number;
  readonly runsPerCase: number;
  readonly aborted?: string | null;
}

/** Judges check 6 and builds the report from records that carry checks 1 to 5. */
export function buildReport(
  records: readonly EvalRecord[],
  cases: readonly EvalCase[],
  meta: ReportMeta,
): EvalReport {
  const judged = judgeFlattening(records, cases);
  return {
    generatedAt: meta.generatedAt,
    model: meta.model,
    promptVersion: meta.promptVersion ?? ASSISTANT_PROMPT_VERSION,
    toolsetVersion: meta.toolsetVersion ?? ASSISTANT_TOOLSET_VERSION,
    runsPerCase: meta.runsPerCase,
    caseIds: cases.map((entry) => entry.id),
    aborted: meta.aborted ?? null,
    records: judged,
    summary: summarize(judged),
  };
}

/**
 * Re-judges kept turns against the current checks: a saved report's
 * proposals replayed without calling the model.
 */
export function evaluateRecords(
  turns: readonly (EvalTurn & { readonly caseId: string; readonly run: number })[],
  cases: readonly EvalCase[],
): EvalRecord[] {
  return turns.map((turn) => {
    const evalCase = cases.find((entry) => entry.id === turn.caseId);
    if (!evalCase) throw new Error(`No eval case "${turn.caseId}"`);
    return evaluateTurn(evalCase, turn.run, turn);
  });
}

/**
 * {@link evaluateTurn}, except that a throw while judging (a bug in a check,
 * say) is kept as an errored record rather than losing every other turn.
 */
export function evaluateTurnSafely(
  evalCase: EvalCase,
  run: number,
  turn: EvalTurn,
): EvalRecord {
  try {
    return evaluateTurn(evalCase, run, turn);
  } catch (error) {
    const judged: EvalTurnError = {
      code: "eval_error",
      message: `Judging the turn threw: ${error instanceof Error ? error.message : String(error)}`,
      providerStatus: null,
      providerFailures: [],
    };
    return {
      ...turn,
      error: describeTurnError(judged),
      turnError: judged,
      caseId: evalCase.id,
      capability: evalCase.capability,
      axis: evalCase.axis,
      request: evalCase.request,
      run,
      checks: {},
      stats: null,
      fingerprint: null,
    };
  }
}

export interface RunEvalsOptions extends RunTurnOptions {
  readonly cases: readonly EvalCase[];
  readonly runs: number;
  /** Turns in flight at once. */
  readonly concurrency?: number;
  readonly onRecord?: (record: EvalRecord) => void;
}

export const AUTH_ABORT_REASON =
  "The provider rejected the API key (HTTP 401/403), so no further turns were run.";

/**
 * Runs every case `runs` times and builds the report. If the provider rejects
 * the API key before any turn has come back with a reply, it stops starting
 * turns: every one would be refused, and the report says so in `aborted`.
 */
export async function runEvals(options: RunEvalsOptions): Promise<EvalReport> {
  const model = options.model ?? ASSISTANT_MODELS[ASSISTANT_MODEL_ID];
  const now = options.now ?? Date.now;
  const jobs = options.cases.flatMap((evalCase) =>
    Array.from({ length: options.runs }, (_, index) => ({ evalCase, run: index + 1 })),
  );
  const records: (EvalRecord | undefined)[] = new Array(jobs.length);
  let next = 0;
  let replied = false;
  let aborted: string | null = null;
  const worker = async () => {
    while (next < jobs.length && aborted === null) {
      const index = next;
      next += 1;
      const { evalCase, run } = jobs[index];
      const turn = await runCaseTurn(evalCase, { ...options, model, now });
      const record = evaluateTurnSafely(evalCase, run, turn);
      records[index] = record;
      if (!turn.error) replied = true;
      else if (!replied && isAuthError(turn.turnError)) aborted = AUTH_ABORT_REASON;
      options.onRecord?.(record);
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 1, jobs.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return buildReport(
    records.filter((record): record is EvalRecord => record !== undefined),
    options.cases,
    {
      generatedAt: new Date(now()).toISOString(),
      model: model.id,
      runsPerCase: options.runs,
      aborted,
    },
  );
}

/**
 * The script's exit status for a finished run: 1 when the run stopped early
 * or every turn errored, since then there is nothing to read the pass rates
 * from; 0 otherwise, whatever the pass rates are.
 */
export function evalExitCode(report: EvalReport): 0 | 1 {
  if (report.aborted) return 1;
  if (report.records.length > 0 && report.summary.errored.total === report.records.length)
    return 1;
  return 0;
}
