/**
 * The assistant evals' scorecard (GRV-102): the one set of numbers a prompt or
 * tool change is judged by, and what it cost to get them.
 *
 * - The **headline** is three pass rates: check 1 (the proposal applies
 *   cleanly), every check together, and check 8 (the expected outcome). Turns
 *   that errored are counted apart and never lower a rate.
 * - The **secondary** numbers are the cost of that score, for the whole run
 *   and per case: turn latency (p50/p95), time to the first streamed text,
 *   input, output and cache-read tokens, the estimated cost per turn from the
 *   model's price in `ASSISTANT_MODELS`, and how often a turn was cut off at
 *   `max_tokens` or refused.
 * - {@link compareScorecards} sets each number beside a baseline's, with its
 *   delta and whether that is better or worse.
 *
 * Everything here is computed from a report's records and its check tallies,
 * so a saved report (a baseline, or a `--replay`) scores the same as the run
 * that wrote it. A report saved before a number was recorded scores it as
 * null ("n/a"), never as zero.
 */
import { ASSISTANT_MODELS, type AssistantModelProfile } from "../config";
import { costMicroUsd } from "../spend";
import type { ProviderUsage } from "../streamEvents";
import { CHECK_IDS, type CheckId } from "./checks";
import type { EvalRecord, Tally } from "./run";

/** A pass rate over the turns a check could judge. */
export interface Rate {
  readonly pass: number;
  readonly judged: number;
  /** `pass / judged`, or null when nothing was judged. */
  readonly rate: number | null;
}

export interface Headline {
  /** Check 1: the proposal applied cleanly. */
  readonly applies: Rate;
  /** Every check's passes over every check's judgements. */
  readonly overall: Rate;
  /** Check 8: a proposal, or the question the case expects. */
  readonly expectMatch: Rate;
  readonly turns: number;
  /** Turns that errored, judged by no check above. */
  readonly errored: number;
}

export interface Percentiles {
  /** How many values they were taken over. */
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

export interface TokenTotals {
  /** Turns whose token counts were recorded. */
  readonly turns: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface Secondary {
  readonly turns: number;
  /** Over the turns that came back with a reply; an errored turn's time is its failure's. */
  readonly latencyMs: Percentiles;
  /** Over the turns that streamed any text. */
  readonly firstTextMs: Percentiles;
  readonly tokens: TokenTotals;
  /** Mean tokens per recorded turn; null when no turn recorded them. */
  readonly meanTokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
  };
  /** Estimated US dollars, from the model's price; null for an unknown model or no tokens. */
  readonly costUsd: { readonly total: number | null; readonly perTurn: number | null };
  /** Every turn's stop reason, a `reply_too_long` error counted as `max_tokens`. */
  readonly stopReasons: Readonly<Record<string, number>>;
  readonly maxTokensRate: number | null;
  readonly refusalRate: number | null;
}

export interface Scorecard {
  readonly headline: Headline;
  readonly secondary: Secondary;
  readonly cases: Readonly<Record<string, Secondary>>;
}

/** What a scorecard is computed from: a report, saved or fresh. */
export interface ScorecardSource {
  readonly model: string;
  readonly caseIds: readonly string[];
  readonly records: readonly EvalRecord[];
  readonly summary: {
    readonly checks: Partial<Record<CheckId, Tally>>;
    readonly errored: { readonly total: number };
  };
}

function rateOf(pass: number, fail: number): Rate {
  const judged = pass + fail;
  return { pass, judged, rate: judged === 0 ? null : pass / judged };
}

/** Nearest-rank percentile (`p` in 0..100) of `values`; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function percentiles(values: readonly number[]): Percentiles {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

export function headlineOf(source: ScorecardSource): Headline {
  const tally = (id: CheckId) =>
    source.summary.checks[id] ?? { pass: 0, fail: 0, skip: 0 };
  let pass = 0;
  let fail = 0;
  for (const id of CHECK_IDS) {
    pass += tally(id).pass;
    fail += tally(id).fail;
  }
  return {
    applies: rateOf(tally("valid").pass, tally("valid").fail),
    overall: rateOf(pass, fail),
    expectMatch: rateOf(tally("outcome").pass, tally("outcome").fail),
    turns: source.records.length,
    errored: source.summary.errored.total,
  };
}

/** The usage the turn recorded, or null for a turn (or an older report) without it. */
function usageOf(record: EvalRecord): ProviderUsage | null {
  return record.usage ?? null;
}

/** Why the turn stopped: its own reason, `max_tokens` for a cut-off reply, else none. */
export function stopReasonOf(record: EvalRecord): string {
  if (record.stopReason) return record.stopReason;
  if (record.turnError?.code === "reply_too_long") return "max_tokens";
  return record.error ? "errored" : "none";
}

/** The configured model a report names, if it is still configured. */
export function modelProfile(model: string): AssistantModelProfile | null {
  return Object.values(ASSISTANT_MODELS).find((profile) => profile.id === model) ?? null;
}

/** The estimated cost of one turn's usage, in US dollars. */
export function turnCostUsd(model: AssistantModelProfile, usage: ProviderUsage): number {
  return costMicroUsd(model, usage) / 1_000_000;
}

export function secondaryOf(
  records: readonly EvalRecord[],
  model: AssistantModelProfile | null,
): Secondary {
  const replied = records.filter((record) => !record.error);
  const firstText = records
    .map((record) => record.firstTextMs)
    .filter((value): value is number => typeof value === "number");
  const usages = records.map(usageOf).filter((usage): usage is ProviderUsage => !!usage);
  const tokens: TokenTotals = {
    turns: usages.length,
    input: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    output: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cacheRead: usages.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0),
    cacheWrite: usages.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
  };
  const mean = (total: number) => (tokens.turns === 0 ? null : total / tokens.turns);
  const totalCost =
    model && usages.length > 0
      ? usages.reduce((sum, usage) => sum + turnCostUsd(model, usage), 0)
      : null;
  const stopReasons: Record<string, number> = {};
  for (const record of records) {
    const reason = stopReasonOf(record);
    stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
  }
  const share = (reason: string) =>
    records.length === 0 ? null : (stopReasons[reason] ?? 0) / records.length;
  return {
    turns: records.length,
    latencyMs: percentiles(replied.map((record) => record.durationMs)),
    firstTextMs: percentiles(firstText),
    tokens,
    meanTokens: {
      input: mean(tokens.input),
      output: mean(tokens.output),
      cacheRead: mean(tokens.cacheRead),
    },
    costUsd: {
      total: totalCost,
      perTurn: totalCost === null ? null : totalCost / usages.length,
    },
    stopReasons,
    maxTokensRate: share("max_tokens"),
    refusalRate: share("refusal"),
  };
}

export function scorecardOf(source: ScorecardSource): Scorecard {
  const model = modelProfile(source.model);
  return {
    headline: headlineOf(source),
    secondary: secondaryOf(source.records, model),
    cases: Object.fromEntries(
      source.caseIds.map((caseId) => [
        caseId,
        secondaryOf(
          source.records.filter((record) => record.caseId === caseId),
          model,
        ),
      ]),
    ),
  };
}

/** How a number is read, and which way is better. */
export type MetricKind = "rate" | "ms" | "tokens" | "usd" | "count";

export interface Metric {
  readonly label: string;
  readonly kind: MetricKind;
  readonly higherIsBetter: boolean;
  readonly value: (card: Scorecard) => number | null;
}

/** Every headline and secondary number, in the order the report prints them. */
export const SCORECARD_METRICS: readonly Metric[] = [
  {
    label: "Applies cleanly (check 1)",
    kind: "rate",
    higherIsBetter: true,
    value: (c) => c.headline.applies.rate,
  },
  {
    label: "Overall pass rate",
    kind: "rate",
    higherIsBetter: true,
    value: (c) => c.headline.overall.rate,
  },
  {
    label: "Expected outcome (check 8)",
    kind: "rate",
    higherIsBetter: true,
    value: (c) => c.headline.expectMatch.rate,
  },
  {
    label: "Errored turns",
    kind: "count",
    higherIsBetter: false,
    value: (c) => c.headline.errored,
  },
  {
    label: "Latency p50",
    kind: "ms",
    higherIsBetter: false,
    value: (c) => c.secondary.latencyMs.p50,
  },
  {
    label: "Latency p95",
    kind: "ms",
    higherIsBetter: false,
    value: (c) => c.secondary.latencyMs.p95,
  },
  {
    label: "First text p50",
    kind: "ms",
    higherIsBetter: false,
    value: (c) => c.secondary.firstTextMs.p50,
  },
  {
    label: "First text p95",
    kind: "ms",
    higherIsBetter: false,
    value: (c) => c.secondary.firstTextMs.p95,
  },
  {
    label: "Input tokens per turn",
    kind: "tokens",
    higherIsBetter: false,
    value: (c) => c.secondary.meanTokens.input,
  },
  {
    label: "Output tokens per turn",
    kind: "tokens",
    higherIsBetter: false,
    value: (c) => c.secondary.meanTokens.output,
  },
  {
    label: "Cache-read tokens per turn",
    kind: "tokens",
    higherIsBetter: false,
    value: (c) => c.secondary.meanTokens.cacheRead,
  },
  {
    label: "Cost per turn",
    kind: "usd",
    higherIsBetter: false,
    value: (c) => c.secondary.costUsd.perTurn,
  },
  {
    label: "Cost of the run",
    kind: "usd",
    higherIsBetter: false,
    value: (c) => c.secondary.costUsd.total,
  },
  {
    label: "Cut off at max_tokens",
    kind: "rate",
    higherIsBetter: false,
    value: (c) => c.secondary.maxTokensRate,
  },
  {
    label: "Refused",
    kind: "rate",
    higherIsBetter: false,
    value: (c) => c.secondary.refusalRate,
  },
];

export type Verdict = "better" | "worse" | "same" | "n/a";

export interface Comparison {
  readonly label: string;
  readonly kind: MetricKind;
  readonly current: number | null;
  readonly baseline: number | null;
  /** `current - baseline`; a rate's delta is in fractions (0.05 is 5 points). */
  readonly delta: number | null;
  readonly verdict: Verdict;
}

export function compareScorecards(current: Scorecard, baseline: Scorecard): Comparison[] {
  return SCORECARD_METRICS.map((metric) => {
    const now = metric.value(current);
    const then = metric.value(baseline);
    const delta = now === null || then === null ? null : now - then;
    const verdict: Verdict =
      delta === null
        ? "n/a"
        : Math.abs(delta) < 1e-9
          ? "same"
          : delta > 0 === metric.higherIsBetter
            ? "better"
            : "worse";
    return {
      label: metric.label,
      kind: metric.kind,
      current: now,
      baseline: then,
      delta,
      verdict,
    };
  });
}

/** One number as the report prints it: "72.5%", "4.3 s", "1,204", "$0.0123". */
export function formatMetric(kind: MetricKind, value: number | null): string {
  if (value === null) return "n/a";
  switch (kind) {
    case "rate":
      return `${(value * 100).toFixed(1)}%`;
    case "ms":
      return `${(value / 1000).toFixed(1)} s`;
    case "tokens":
      return Math.round(value).toLocaleString("en-US");
    case "usd":
      return `$${value.toFixed(4)}`;
    case "count":
      return String(value);
  }
}

/** A delta with its sign: "+2.5 pp", "-1.2 s", "+310", "-$0.0040". */
export function formatDelta(kind: MetricKind, delta: number | null): string {
  if (delta === null) return "n/a";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  const size = Math.abs(delta);
  switch (kind) {
    case "rate":
      return `${sign}${(size * 100).toFixed(1)} pp`;
    case "ms":
      return `${sign}${(size / 1000).toFixed(1)} s`;
    case "tokens":
      return `${sign}${Math.round(size).toLocaleString("en-US")}`;
    case "usd":
      return `${sign}$${size.toFixed(4)}`;
    case "count":
      return `${sign}${size}`;
  }
}
