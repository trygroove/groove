/**
 * The scorecard as the eval report prints it (GRV-102): the headline first,
 * then the secondary numbers for the run and per case, and, given a baseline,
 * every number beside the baseline's with its delta. `report.md`, the console
 * summary and `docs/assistant-eval-baseline.md` all read from here.
 */
import {
  type Comparison,
  formatDelta,
  formatMetric,
  type Rate,
  type Scorecard,
  type Secondary,
} from "./scorecard";

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
    "| Case | Turns | Latency p50 | p95 | First text p50 | Input tok | Output tok | Cache read tok | Cost/turn | Stop reasons |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(card.cases).map(
      ([caseId, s]) =>
        `| \`${caseId}\` | ${s.turns} | ${formatMetric("ms", s.latencyMs.p50)} | ${formatMetric("ms", s.latencyMs.p95)} | ${formatMetric("ms", s.firstTextMs.p50)} | ${formatMetric("tokens", s.meanTokens.input)} | ${formatMetric("tokens", s.meanTokens.output)} | ${formatMetric("tokens", s.meanTokens.cacheRead)} | ${formatMetric("usd", s.costUsd.perTurn)} | ${stopReasonMix(s)} |`,
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
}

export function comparisonLines(
  comparisons: readonly Comparison[],
  baseline: BaselineLabel,
): string[] {
  return [
    "## Against the baseline",
    "",
    `Baseline: \`${baseline.path}\` (run ${baseline.generatedAt}, model \`${baseline.model}\`, prompt \`${baseline.promptVersion}\`).`,
    "",
    "| Number | This run | Baseline | Delta | |",
    "| --- | --- | --- | --- | --- |",
    ...comparisons.map(
      (row) =>
        `| ${row.label} | ${formatMetric(row.kind, row.current)} | ${formatMetric(row.kind, row.baseline)} | ${formatDelta(row.kind, row.delta)} | ${row.verdict} |`,
    ),
    "",
  ];
}

/** The comparison as fixed-width console lines. */
export function comparisonConsoleLines(comparisons: readonly Comparison[]): string[] {
  return comparisons.map(
    (row) =>
      `  ${row.label.padEnd(28)} ${formatMetric(row.kind, row.current).padStart(10)}  was ${formatMetric(row.kind, row.baseline).padStart(10)}  ${formatDelta(row.kind, row.delta).padStart(10)}  ${row.verdict}`,
  );
}
