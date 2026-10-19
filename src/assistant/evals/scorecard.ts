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
 *   model's price in `ASSISTANT_MODELS`, how often a turn was cut off at
 *   `max_tokens` or refused, and the model calls a turn made (GRV-142).
 * - The **sets** (GRV-119): the headline again for each set of cases (the
 *   musical capability evals, the basic production actions), so each set
 *   reads as its own score beside the run's.
 * - The **heavy set** (GRV-131): the mean, over the heavy-output cases the
 *   run has, of each case's output tokens per turn, latency p50 and cost per
 *   turn: the three numbers an output-token lever is judged by; and of its
 *   model calls per turn, mean and p95 (GRV-142), which say how many round
 *   trips that latency is made of.
 * - {@link compareScorecards} sets each number beside a baseline's, with its
 *   delta and whether that is better or worse, set by set: a run of both sets
 *   compared with a baseline of one compares like with like.
 *   {@link compareHeavySets} does the same for the heavy set, over the heavy
 *   cases both runs have.
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
import { HEAVY_OUTPUT_CASE_IDS } from "./sets";

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

/** The model calls a turn made, retries included (GRV-142). */
export interface ModelCalls {
  /** How many turns recorded them. */
  readonly count: number;
  readonly mean: number | null;
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
  /**
   * Over the turns that recorded their steps. Absent from scorecards saved
   * before it existed.
   */
  readonly modelCalls?: ModelCalls;
}

/** One set's score: how many of its cases ran, its headline, and what it cost. */
export interface SetScore {
  readonly cases: number;
  readonly headline: Headline;
  readonly secondary: Secondary;
}

/** What a set of numbers is read off: a whole scorecard, or one set's score. */
export type ScoreView = Pick<Scorecard, "headline" | "secondary">;

export interface Scorecard {
  readonly headline: Headline;
  /**
   * The headline per set, by set ID, in the order the records first name
   * them. Absent from scorecards saved before sets existed.
   */
  readonly sets?: Readonly<Record<string, SetScore>>;
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

function modelCallsOf(records: readonly EvalRecord[]): ModelCalls {
  const calls = records
    .map((record) => record.steps?.calls)
    .filter((value): value is number => typeof value === "number");
  return {
    count: calls.length,
    mean: calls.length === 0 ? null : calls.reduce((a, b) => a + b, 0) / calls.length,
    p95: percentile(calls, 95),
  };
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
    modelCalls: modelCallsOf(records),
  };
}

/** The set a record was scored in; a record saved before sets is a musical one. */
export function recordSet(record: EvalRecord): string {
  return record.set ?? "musical";
}

/** Each set's headline, tallied from its own records. */
export function setScoresOf(
  model: string,
  records: readonly EvalRecord[],
): Record<string, SetScore> {
  const profile = modelProfile(model);
  const sets: Record<string, SetScore> = {};
  for (const set of [...new Set(records.map(recordSet))]) {
    const own = records.filter((record) => recordSet(record) === set);
    const checks: Partial<Record<CheckId, Tally>> = {};
    for (const record of own) {
      if (record.error) continue;
      for (const id of CHECK_IDS) {
        const result = record.checks[id];
        if (!result) continue;
        const tally = checks[id] ?? { pass: 0, fail: 0, skip: 0 };
        tally[result.status] += 1;
        checks[id] = tally;
      }
    }
    const caseIds = [...new Set(own.map((record) => record.caseId))];
    sets[set] = {
      cases: caseIds.length,
      headline: headlineOf({
        model,
        caseIds,
        records: own,
        summary: {
          checks,
          errored: { total: own.filter((record) => record.error).length },
        },
      }),
      secondary: secondaryOf(own, profile),
    };
  }
  return sets;
}

export function scorecardOf(source: ScorecardSource): Scorecard {
  const model = modelProfile(source.model);
  return {
    headline: headlineOf(source),
    sets: setScoresOf(source.model, source.records),
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
export type MetricKind = "rate" | "ms" | "tokens" | "usd" | "count" | "calls";

export interface Metric<View = ScoreView> {
  readonly label: string;
  readonly kind: MetricKind;
  readonly higherIsBetter: boolean;
  readonly value: (card: View) => number | null;
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
  /** The set the row compares, or absent for a scorecard without sets. */
  readonly set?: string;
  readonly label: string;
  readonly kind: MetricKind;
  readonly current: number | null;
  readonly baseline: number | null;
  /** `current - baseline`; a rate's delta is in fractions (0.05 is 5 points). */
  readonly delta: number | null;
  readonly verdict: Verdict;
}

/**
 * A set's numbers in a baseline: its own score when the baseline has sets,
 * the whole baseline when it has none and the set is the musical one (every
 * case was musical before sets existed), and nothing otherwise.
 */
function baselineSet(baseline: Scorecard, set: string): ScoreView | null {
  if (baseline.sets && Object.keys(baseline.sets).length > 0) {
    return baseline.sets[set] ?? null;
  }
  return set === "musical" ? baseline : null;
}

/**
 * Every number beside the baseline's. A scorecard with sets is compared set
 * by set, each against the same set in the baseline, so a run of both sets
 * against a musical-only baseline compares the musical cases with the
 * musical cases, and the basic actions with nothing (n/a).
 */
export function compareScorecards(current: Scorecard, baseline: Scorecard): Comparison[] {
  const sets = Object.entries(current.sets ?? {});
  if (sets.length === 0) return compareViews(current, baseline);
  return sets.flatMap(([set, score]) =>
    compareViews(score, baselineSet(baseline, set)).map((row) => ({ set, ...row })),
  );
}

function compareViews(current: ScoreView, baseline: ScoreView | null): Comparison[] {
  return compareMetrics(SCORECARD_METRICS, current, baseline);
}

function compareMetrics<View>(
  metrics: readonly Metric<View>[],
  current: View,
  baseline: View | null,
): Comparison[] {
  return metrics.map((metric) => {
    const now = metric.value(current);
    const then = baseline ? metric.value(baseline) : null;
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

/**
 * The heavy set's numbers (GRV-131, GRV-142), each the plain mean of the
 * per-case figure over the heavy cases scored, so every case weighs the same
 * however many of its turns errored.
 */
export interface HeavySet {
  /** The heavy cases these numbers are over, in the group's order. */
  readonly caseIds: readonly string[];
  readonly outputTokens: number | null;
  readonly latencyP50Ms: number | null;
  readonly costPerTurnUsd: number | null;
  /** Each case's mean model calls per turn, averaged (GRV-142). */
  readonly modelCallsMean: number | null;
  /** Each case's p95 of model calls per turn, averaged (GRV-142). */
  readonly modelCallsP95: number | null;
}

function meanOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

/**
 * The heavy set of a scorecard, over the heavy cases it scored (or only
 * those of `caseIds`); null when it scored none of them.
 */
export function heavySetOf(
  card: Pick<Scorecard, "cases">,
  caseIds: readonly string[] = HEAVY_OUTPUT_CASE_IDS,
): HeavySet | null {
  const ids = HEAVY_OUTPUT_CASE_IDS.filter(
    (id) => caseIds.includes(id) && card.cases[id] !== undefined,
  );
  if (ids.length === 0) return null;
  const cases = ids.map((id) => card.cases[id]);
  return {
    caseIds: ids,
    outputTokens: meanOf(cases.map((s) => s.meanTokens.output)),
    latencyP50Ms: meanOf(cases.map((s) => s.latencyMs.p50)),
    costPerTurnUsd: meanOf(cases.map((s) => s.costUsd.perTurn)),
    modelCallsMean: meanOf(cases.map((s) => s.modelCalls?.mean ?? null)),
    modelCallsP95: meanOf(cases.map((s) => s.modelCalls?.p95 ?? null)),
  };
}

export const HEAVY_SET_METRICS: readonly Metric<HeavySet>[] = [
  {
    label: "Mean output tokens per turn",
    kind: "tokens",
    higherIsBetter: false,
    value: (h) => h.outputTokens,
  },
  {
    label: "Mean latency p50",
    kind: "ms",
    higherIsBetter: false,
    value: (h) => h.latencyP50Ms,
  },
  {
    label: "Mean cost per turn",
    kind: "usd",
    higherIsBetter: false,
    value: (h) => h.costPerTurnUsd,
  },
  {
    label: "Mean model calls per turn",
    kind: "calls",
    higherIsBetter: false,
    value: (h) => h.modelCallsMean,
  },
  {
    label: "Mean model calls p95",
    kind: "calls",
    higherIsBetter: false,
    value: (h) => h.modelCallsP95,
  },
];

/**
 * The heavy set beside the baseline's, the baseline taken over the same
 * heavy cases this run scored (n/a when it has none of them); null when this
 * run scored no heavy case.
 */
export function compareHeavySets(
  current: Scorecard,
  baseline: Scorecard,
): Comparison[] | null {
  const now = heavySetOf(current);
  if (!now) return null;
  return compareMetrics(HEAVY_SET_METRICS, now, heavySetOf(baseline, now.caseIds));
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
    case "calls":
      return value.toFixed(1);
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
    case "calls":
      return `${sign}${size.toFixed(1)}`;
  }
}
