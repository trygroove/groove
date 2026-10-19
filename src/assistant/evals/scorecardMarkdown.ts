/**
 * The scorecard as the eval report prints it (GRV-102): the headline first,
 * then the secondary numbers for the run and per case, and, given a baseline,
 * every number beside the baseline's with its delta; and the heavy set
 * (GRV-131), beside the baseline's too. `report.md`, the console
 * summary and `docs/assistant-eval-baseline.md` all read from here.
 */

import { describeTactics, type TacticOverrides } from "../tactics";
import {
  type Comparison,
  formatDelta,
  formatMetric,
  HEAVY_SET_METRICS,
  heavySetOf,
  type Rate,
  type Scorecard,
  type Secondary,
} from "./scorecard";
import { setLabel } from "./sets";

/** "72.5% (29/40)", or "n/a (0 judged)". */
export function formatRate(rate: Rate): string {
  return `${formatMetric("rate", rate.rate)} (${rate.pass}/${rate.judged})`;
}

function stopReasonMix(secondary: Secondary): string {
  const entries = Object.entries(secondary.stopReasons).sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return entries.length === 0
    ? "none"
    : entries.map(([reason, count]) => `${reason} ${count}`).join(", ");
}

export function headlineLines(card: Scorecard): string[] {
  const { headline } = card;
  return [
    "## Headline",
    "",
    "| Score | Value |",
    "| --- | --- |",
    `| Applies cleanly (check 1) | ${formatRate(headline.applies)} |`,
    `| Overall pass rate (every check) | ${formatRate(headline.overall)} |`,
    `| Expected outcome (check 8) | ${formatRate(headline.expectMatch)} |`,
    `| Errored turns (judged by no check) | ${headline.errored} of ${headline.turns} |`,
    "",
  ];
}

/** The headline per set (GRV-119); nothing for a scorecard without sets. */
export function setLines(card: Scorecard): string[] {
  const sets = Object.entries(card.sets ?? {});
  if (sets.length === 0) return [];
  return [
    "## By set",
    "",
    "| Set | Cases | Applies cleanly (check 1) | Overall pass rate | Expected outcome (check 8) | Errored turns |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sets.map(
      ([set, { cases, headline }]) =>
        `| ${setLabel(set)} | ${cases} | ${formatRate(headline.applies)} | ${formatRate(headline.overall)} | ${formatRate(headline.expectMatch)} | ${headline.errored} of ${headline.turns} |`,
    ),
    "",
  ];
}

/**
 * The heavy set's numbers (GRV-131, GRV-142), beside the baseline's when there
 * is one; nothing for a run with no heavy case.
 */
export function heavySetLines(
  card: Scorecard,
  comparisons?: readonly Comparison[] | null,
): string[] {
  const heavy = heavySetOf(card);
  if (!heavy) return [];
  const intro = [
    "## Heavy set",
    "",
    `The mean of each case's figure over the ${heavy.caseIds.length} heavy-output cases this run scored (${heavy.caseIds.map((id) => `\`${id}\``).join(", ")}), every case weighing the same.`,
    "",
  ];
  if (comparisons) {
    return [
      ...intro,
      "| Number | This run | Baseline | Delta | |",
      "| --- | --- | --- | --- | --- |",
      ...comparisons.map(
        (row) =>
          `| ${row.label} | ${formatMetric(row.kind, row.current)} | ${formatMetric(row.kind, row.baseline)} | ${formatDelta(row.kind, row.delta)} | ${row.verdict} |`,
      ),
      "",
    ];
  }
  return [
    ...intro,
    "| Number | Value |",
    "| --- | --- |",
    ...HEAVY_SET_METRICS.map(
      (metric) =>
        `| ${metric.label} | ${formatMetric(metric.kind, metric.value(heavy))} |`,
    ),
    "",
  ];
}

/** The heavy set beside the baseline's, as fixed-width console lines. */
export function heavySetConsoleLines(comparisons: readonly Comparison[]): string[] {
  return [
    "  Heavy set:",
    ...comparisons.map(
      (row) =>
        `  ${row.label.padEnd(28)} ${formatMetric(row.kind, row.current).padStart(10)}  was ${formatMetric(row.kind, row.baseline).padStart(10)}  ${formatDelta(row.kind, row.delta).padStart(10)}  ${row.verdict}`,
    ),
  ];
}

export function secondaryLines(card: Scorecard): string[] {
  const s = card.secondary;
  return [
    "## Cost of the score",
    "",
    "Latency is over the turns that replied, first text over the turns that streamed any, tokens over the turns that recorded them; cost is estimated from the model's price in `ASSISTANT_MODELS`.",
    "",
    "| Number | Value |",
    "| --- | --- |",
    `| Latency p50 / p95 | ${formatMetric("ms", s.latencyMs.p50)} / ${formatMetric("ms", s.latencyMs.p95)} (${s.latencyMs.count} turns) |`,
    `| First text p50 / p95 | ${formatMetric("ms", s.firstTextMs.p50)} / ${formatMetric("ms", s.firstTextMs.p95)} (${s.firstTextMs.count} turns) |`,
    `| Input tokens per turn | ${formatMetric("tokens", s.meanTokens.input)} |`,
    `| Output tokens per turn | ${formatMetric("tokens", s.meanTokens.output)} |`,
    `| Cache-read tokens per turn | ${formatMetric("tokens", s.meanTokens.cacheRead)} |`,
    `| Cache-write tokens per turn | ${formatMetric("tokens", s.meanTokens.cacheWrite ?? null)} |`,
    `| Tokens in all (input / output / cache read / cache write) | ${[s.tokens.input, s.tokens.output, s.tokens.cacheRead, s.tokens.cacheWrite].map((n) => formatMetric("tokens", n)).join(" / ")} (${s.tokens.turns} turns) |`,
    `| Cost per turn / of the run | ${formatMetric("usd", s.costUsd.perTurn)} / ${formatMetric("usd", s.costUsd.total)} |`,
    `| Stop reasons | ${stopReasonMix(s)} |`,
    `| Cut off at max_tokens / refused | ${formatMetric("rate", s.maxTokensRate)} / ${formatMetric("rate", s.refusalRate)} |`,
    "",
  ];
}

export function caseSecondaryLines(card: Scorecard): string[] {
  return [
    "## Cost by case",
    "",
    "| Case | Turns | Latency p50 | p95 | First text p50 | Model calls mean / p95 | Input tok | Output tok | Cache read tok | Cost/turn | Stop reasons |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(card.cases).map(
      ([caseId, s]) =>
        `| \`${caseId}\` | ${s.turns} | ${formatMetric("ms", s.latencyMs.p50)} | ${formatMetric("ms", s.latencyMs.p95)} | ${formatMetric("ms", s.firstTextMs.p50)} | ${formatMetric("calls", s.modelCalls?.mean ?? null)} / ${formatMetric("calls", s.modelCalls?.p95 ?? null)} | ${formatMetric("tokens", s.meanTokens.input)} | ${formatMetric("tokens", s.meanTokens.output)} | ${formatMetric("tokens", s.meanTokens.cacheRead)} | ${formatMetric("usd", s.costUsd.perTurn)} | ${stopReasonMix(s)} |`,
    ),
    "",
  ];
}

/** Who the baseline was, as the comparison heading names it. */
export interface BaselineLabel {
  readonly path: string;
  readonly generatedAt: string;
  readonly model: string;
  readonly promptVersion: string;
  /** The tactic values it ran with (GRV-110); null for a baseline saved before reports named them. */
  readonly tactics: TacticOverrides | null;
}

/** A report's tactic values as one line, or "unknown" for a report that names none. */
export function tacticsText(tactics: TacticOverrides | null | undefined): string {
  return tactics ? describeTactics(tactics) || "none" : "unknown";
}

/** The rows grouped by set, in the order they come; one group with no set. */
function bySet(
  comparisons: readonly Comparison[],
): { set: string | undefined; rows: Comparison[] }[] {
  const groups: { set: string | undefined; rows: Comparison[] }[] = [];
  for (const row of comparisons) {
    const last = groups.at(-1);
    if (last && last.set === row.set) last.rows.push(row);
    else groups.push({ set: row.set, rows: [row] });
  }
  return groups;
}

/**
 * The comparison's tables, each set's under a heading at `level`: GRV-102's
 * diff format, which an experiment's report (GRV-110) reuses with the
 * control as the baseline.
 */
export function comparisonTables(
  comparisons: readonly Comparison[],
  level = "###",
  columns: { readonly current: string; readonly baseline: string } = {
    current: "This run",
    baseline: "Baseline",
  },
): string[] {
  const table = (rows: readonly Comparison[]) => [
    `| Number | ${columns.current} | ${columns.baseline} | Delta | |`,
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.label} | ${formatMetric(row.kind, row.current)} | ${formatMetric(row.kind, row.baseline)} | ${formatDelta(row.kind, row.delta)} | ${row.verdict} |`,
    ),
    "",
  ];
  return bySet(comparisons).flatMap(({ set, rows }) =>
    set === undefined ? table(rows) : [`${level} ${setLabel(set)}`, "", ...table(rows)],
  );
}

export function comparisonLines(
  comparisons: readonly Comparison[],
  baseline: BaselineLabel,
): string[] {
  return [
    "## Against the baseline",
    "",
    `Baseline: \`${baseline.path}\` (run ${baseline.generatedAt}, model \`${baseline.model}\`, prompt \`${baseline.promptVersion}\`, tactics ${tacticsText(baseline.tactics)}).`,
    "",
    ...comparisonTables(comparisons),
  ];
}

/** The comparison as fixed-width console lines, under each set's name. */
export function comparisonConsoleLines(comparisons: readonly Comparison[]): string[] {
  return bySet(comparisons).flatMap(({ set, rows }) => [
    ...(set === undefined ? [] : [`  ${setLabel(set)}:`]),
    ...rows.map(
      (row) =>
        `  ${row.label.padEnd(28)} ${formatMetric(row.kind, row.current).padStart(10)}  was ${formatMetric(row.kind, row.baseline).padStart(10)}  ${formatDelta(row.kind, row.delta).padStart(10)}  ${row.verdict}`,
    ),
  ]);
}
