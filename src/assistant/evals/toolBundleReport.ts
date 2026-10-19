/**
 * What an experiment's report says about tool bundles (GRV-143): which
 * bundle the rule picked for each case, how often a turn fell back to every
 * tool, and the cache-read and cache-write tokens per turn beside the
 * control's, since a bundle's first use writes a cache entry of its own.
 *
 * Counted per turn, a session's turns one by one. Pure, over the eval
 * reports, so it is tested without a run.
 */
import type { ToolBundleFallback } from "../telemetry";
import type { EvalRecord, EvalReport, EvalTurn } from "./run";
import { formatMetric } from "./scorecard";

export interface CaseBundles {
  readonly turns: number;
  /** How many turns opened with each bundle; a turn offered every tool by `all` is not counted. */
  readonly bundles: Readonly<Record<string, number>>;
  readonly fallbacks: Readonly<Record<ToolBundleFallback, number>>;
  /** Mean tokens per turn over the turns that recorded them; null when none did. */
  readonly cacheReadPerTurn: number | null;
  readonly cacheWritePerTurn: number | null;
}

export interface ToolBundleSummary {
  /** Every case's numbers, and the report's own under `overall`. */
  readonly overall: CaseBundles;
  readonly cases: Readonly<Record<string, CaseBundles>>;
}

/** A record's turns: a session's each, or the record itself. */
function turnsOf(record: EvalRecord): readonly EvalTurn[] {
  return record.session ? record.session.turns : [record];
}

function bundlesOf(turns: readonly EvalTurn[]): CaseBundles {
  const bundles: Record<string, number> = {};
  const fallbacks: Record<ToolBundleFallback, number> = {
    need_more_tools: 0,
    unoffered_tool: 0,
  };
  let read = 0;
  let write = 0;
  let measured = 0;
  for (const turn of turns) {
    const chosen = turn.toolBundle;
    if (chosen) {
      bundles[chosen.bundle] = (bundles[chosen.bundle] ?? 0) + 1;
      if (chosen.fallback) fallbacks[chosen.fallback] += 1;
    }
    if (turn.usage) {
      read += turn.usage.cacheReadInputTokens;
      write += turn.usage.cacheCreationInputTokens;
      measured += 1;
    }
  }
  return {
    turns: turns.length,
    bundles,
    fallbacks,
    cacheReadPerTurn: measured === 0 ? null : read / measured,
    cacheWritePerTurn: measured === 0 ? null : write / measured,
  };
}

/** The report's bundles and cache tokens, overall and case by case. */
export function toolBundleSummary(
  report: Pick<EvalReport, "records">,
): ToolBundleSummary {
  const byCase = new Map<string, EvalTurn[]>();
  for (const record of report.records) {
    const turns = byCase.get(record.caseId) ?? [];
    turns.push(...turnsOf(record));
    byCase.set(record.caseId, turns);
  }
  return {
    overall: bundlesOf(report.records.flatMap(turnsOf)),
    cases: Object.fromEntries(
      [...byCase].map(([caseId, turns]) => [caseId, bundlesOf(turns)]),
    ),
  };
}

/** Whether any turn in `summary` was offered a bundle. */
export function hasBundles(summary: ToolBundleSummary): boolean {
  return Object.keys(summary.overall.bundles).length > 0;
}

function fallbackCount(entry: CaseBundles): number {
  return entry.fallbacks.need_more_tools + entry.fallbacks.unoffered_tool;
}

function bundleText(entry: CaseBundles): string {
  const parts = Object.entries(entry.bundles)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bundle, count]) => `${bundle} ×${count}`);
  return parts.length === 0 ? "all tools" : parts.join(", ");
}

function percent(count: number, of: number): string {
  return of === 0 ? "n/a" : `${Math.round((count / of) * 100)}%`;
}

const tokens = (value: number | null) => formatMetric("tokens", value);

/**
 * The report's "Tool bundles" section for `variant` against `control`, or
 * nothing when the variant offered no turn a bundle.
 */
export function toolBundleLines(
  control: Pick<EvalReport, "records">,
  variant: Pick<EvalReport, "records">,
  heading: string,
): string[] {
  const ours = toolBundleSummary(variant);
  if (!hasBundles(ours)) return [];
  const theirs = toolBundleSummary(control);
  const { overall } = ours;
  const fell = fallbackCount(overall);
  return [
    `${heading} Tool bundles`,
    "",
    `- Bundles chosen: ${bundleText(overall)} over ${overall.turns} turns.`,
    `- Fell back to every tool: ${fell} of ${overall.turns} turns (${percent(fell, overall.turns)}): ${overall.fallbacks.need_more_tools} through need_more_tools, ${overall.fallbacks.unoffered_tool} by calling a tool the bundle did not offer.`,
    `- Cache-read tokens per turn: ${tokens(theirs.overall.cacheReadPerTurn)} (control) to ${tokens(overall.cacheReadPerTurn)}; cache-write: ${tokens(theirs.overall.cacheWritePerTurn)} to ${tokens(overall.cacheWritePerTurn)}.`,
    "",
    "| Case | Bundle | Fallbacks | Cache read per turn, control to variant | Cache write per turn, control to variant |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(ours.cases).map(([caseId, entry]) => {
      const control = theirs.cases[caseId];
      return `| \`${caseId}\` | ${bundleText(entry)} | ${fallbackCount(entry)} of ${entry.turns} | ${tokens(control?.cacheReadPerTurn ?? null)} to ${tokens(entry.cacheReadPerTurn)} | ${tokens(control?.cacheWritePerTurn ?? null)} to ${tokens(entry.cacheWritePerTurn)} |`;
    }),
    "",
  ];
}
