/**
 * Hand-built assistant eval records and reports (GRV-102), for the scorecard's
 * tests: each record says only what a scorecard reads (its case, its time,
 * its usage, its stop and two checks), so an aggregate can be worked out by
 * hand beside the test.
 */
import type { CheckResult } from "../assistant/evals/checks";
import {
  type EvalRecord,
  type EvalReport,
  type EvalTurnError,
  summarize,
} from "../assistant/evals/run";
import { scorecardOf } from "../assistant/evals/scorecard";
import type { AssistantStopReason } from "../assistant/protocol";
import type { ProviderUsage } from "../assistant/streamEvents";

export interface TestRecordOptions {
  readonly caseId?: string;
  readonly run?: number;
  readonly durationMs?: number;
  readonly firstTextMs?: number | null;
  readonly usage?: Partial<ProviderUsage> | null;
  readonly stopReason?: AssistantStopReason | null;
  /** Check 1; `undefined` leaves it unjudged. */
  readonly valid?: CheckResult["status"];
  /** Check 8. */
  readonly outcome?: CheckResult["status"];
  /** An errored turn's gateway code; such a turn carries no checks. */
  readonly errorCode?: string;
}

export function testRecord(options: TestRecordOptions = {}): EvalRecord {
  const turnError: EvalTurnError | null = options.errorCode
    ? {
        code: options.errorCode,
        message: "scripted",
        providerStatus: null,
        providerFailures: [],
      }
    : null;
  const usage =
    options.usage === null
      ? null
      : {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          ...options.usage,
        };
  const checks: EvalRecord["checks"] = turnError
    ? {}
    : {
        valid: { status: options.valid ?? "pass", detail: "" },
        outcome: { status: options.outcome ?? "pass", detail: "" },
      };
  return {
    caseId: options.caseId ?? "case-a",
    capability: "loopSketch",
    axis: "conventional",
    request: "Make a loop.",
    run: options.run ?? 1,
    durationMs: options.durationMs ?? 10_000,
    firstTextMs: options.firstTextMs === undefined ? 2_000 : options.firstTextMs,
    usage,
    error: turnError ? `${turnError.code}: scripted` : null,
    turnError,
    stopReason: turnError ? null : (options.stopReason ?? "tool_use"),
    text: "",
    proposal: null,
    checks,
    stats: null,
    fingerprint: null,
  };
}

/** A report over `records`, scored the way `buildReport` scores one. */
export function buildTestReport(
  records: readonly EvalRecord[],
  model = "claude-sonnet-5",
): EvalReport {
  const caseIds = [...new Set(records.map((record) => record.caseId))];
  const summary = summarize(records);
  return {
    generatedAt: "2026-10-12T00:00:00.000Z",
    model,
    promptVersion: "test-prompt",
    toolsetVersion: 1,
    runsPerCase: 1,
    caseIds,
    aborted: null,
    scorecard: scorecardOf({ model, caseIds, records, summary }),
    summary,
    records,
  };
}
