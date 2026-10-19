/**
 * The Markdown summary of an assistant eval run (GRV-6): the scorecard's
 * headline and its cost (GRV-102), beside a baseline's when one is given, the
 * pass rate per check, a case-by-check grid, why check 1 failed in each case, every
 * failure with its reason, and the
 * descriptive numbers per run. The JSON report beside it keeps everything,
 * every proposal included; this is the page a human reads first.
 */
import { CHECK_IDS, CHECK_LABELS, type CheckId, type ValidFailureKind } from "./checks";
import type { EvalRecord, EvalReport, EvalSummary, Tally } from "./run";
import { type Comparison, formatMetric } from "./scorecard";
import {
  type BaselineLabel,
  caseSecondaryLines,
  comparisonLines,
  headlineLines,
  heavySetLines,
  secondaryLines,
  setLines,
  tacticsText,
} from "./scorecardMarkdown";

/** A check's number, as the tables name it: "16". */
function checkNumber(id: CheckId): string {
  return CHECK_LABELS[id].split(".")[0];
}

/** The checks that failed, by number, or "none". */
function failedChecks(checks: EvalRecord["checks"]): string {
  const failed = CHECK_IDS.filter((id) => checks[id]?.status === "fail").map(checkNumber);
  return failed.length === 0 ? "none" : failed.join(", ");
}

/**
 * Every session run (GRV-145): its turns and how it ended, each turn's output
 * tokens and latency, the checks the final song failed, and the checks any
 * turn's own proposal failed. Nothing when no run was a session.
 */
export function sessionLines(
  records: readonly EvalRecord[],
  heading = "## Sessions",
): string[] {
  const sessions = records.filter((record) => record.session);
  if (sessions.length === 0) return [];
  return [
    heading,
    "",
    "Each session case's runs, turn by turn: the case's checks judge the final song, and each turn's own proposal is judged by checks 1, 16 and 20.",
    "",
    "| Case | Run | Turns | Ended | Output tokens per turn | Latency per turn | Final song failed | Turns failed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...sessions.map((record) => {
      const session = record.session as NonNullable<EvalRecord["session"]>;
      const tokens = session.turns
        .map((turn) => formatMetric("tokens", turn.usage?.outputTokens ?? null))
        .join(" / ");
      const latency = session.turns
        .map((turn) => formatMetric("ms", turn.durationMs))
        .join(" / ");
      const turnsFailed = (record.turnChecks ?? [])
        .map((checks, index) => [index + 1, failedChecks(checks)] as const)
        .filter(([, failed]) => failed !== "none")
        .map(([turn, failed]) => `turn ${turn}: ${failed}`);
      return `| \`${record.caseId}\` | ${record.run} | ${session.turns.length} of ${session.maxTurns} | ${session.ended} | ${tokens} | ${latency} | ${record.error ? "errored, not judged" : failedChecks(record.checks)} | ${turnsFailed.length === 0 ? "none" : turnsFailed.join("; ")} |`;
    }),
    "",
  ];
}

/** A baseline to print the scorecard against. */
export interface MarkdownBaseline {
  readonly label: BaselineLabel;
  readonly comparisons: readonly Comparison[];
  /** The heavy set beside the baseline's (GRV-131); null when the run has no heavy case. */
  readonly heavy?: readonly Comparison[] | null;
}

/** "7/9 (78%)" over the proposals the check could judge; skips said apart. */
export function formatTally(tally: Tally | undefined): string {
  if (!tally) return "n/a";
  const judged = tally.pass + tally.fail;
  const rate = judged === 0 ? "n/a" : `${Math.round((tally.pass / judged) * 100)}%`;
  const skipped = tally.skip > 0 ? `, ${tally.skip} not judged` : "";
  return `${tally.pass}/${judged} (${rate}${skipped})`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Where a run's output tokens went, in characters of each kind of block. */
function tokensLine(record: EvalRecord): string | null {
  const tokens = record.tokens;
  if (!tokens) return null;
  const count = tokens.outputTokens === null ? "?" : String(tokens.outputTokens);
  const usage = record.usage
    ? `; input ${record.usage.inputTokens}, cache read ${record.usage.cacheReadInputTokens}`
    : "";
  return `Output tokens ${count}${usage}; streamed characters: thinking ${tokens.thinkingChars}, tool input ${tokens.toolInputChars}, text ${tokens.textChars}`;
}

function statsLine(record: EvalRecord): string {
  const stats = record.stats;
  if (!stats) return "did not apply";
  const parts = [
    `${stats.commandCount} commands`,
    `notes ${stats.noteDelta >= 0 ? "+" : ""}${stats.noteDelta}`,
    stats.notesInTouchedClips > 0
      ? `${stats.notesInTouchedClips} in touched clips`
      : null,
    stats.padHitsInTouchedClips > 0 ? `${stats.padHitsInTouchedClips} pad hits` : null,
    stats.pitchRange ? `pitch ${stats.pitchRange[0]}-${stats.pitchRange[1]}` : null,
    stats.meanVelocity !== null ? `velocity ${stats.meanVelocity}` : null,
    stats.offGridNotes > 0 ? `${stats.offGridNotes} off the 1/16 grid` : null,
    stats.tracksAdded > 0 ? `+${stats.tracksAdded} tracks` : null,
    stats.clipsAdded > 0 ? `+${stats.clipsAdded} clips` : null,
    stats.placementsAdded > 0 ? `+${stats.placementsAdded} placements` : null,
    stats.devicesAdded > 0 ? `+${stats.devicesAdded} devices` : null,
    `${stats.tempo} BPM, swing ${stats.swing}`,
    ...stats.deviceParameters,
    ...stats.mixer,
  ];
  return parts.filter((part): part is string => part !== null).join("; ");
}

const VALID_FAILURE_KINDS: readonly ValidFailureKind[] = [
  "no proposal",
  "schema",
  "range",
  "executor",
];

/** Check 1's failure on one run in a line short enough for a console, or null. */
export function validFailureLine(record: EvalRecord, maxLength = 200): string | null {
  const result = record.checks.valid;
  if (result?.status !== "fail") return null;
  const detail = cell(result.detail);
  return detail.length > maxLength ? `${detail.slice(0, maxLength - 3)}...` : detail;
}

/**
 * Why check 1 failed, case by case: how many failures of each kind, then each
 * distinct reason with how many runs gave it, so a cause shared by every run
 * reads as one line.
 */
function validFailureLines(report: EvalReport): string[] {
  const failed = report.records.filter(
    (record) => record.checks.valid?.status === "fail",
  );
  if (failed.length === 0) return [];
  const lines = [
    "## Why check 1 failed",
    "",
    `| Case | ${VALID_FAILURE_KINDS.join(" | ")} |`,
    `| --- | ${VALID_FAILURE_KINDS.map(() => "---").join(" | ")} |`,
  ];
  const reasons: string[] = [];
  for (const caseId of report.caseIds) {
    const records = failed.filter((record) => record.caseId === caseId);
    if (records.length === 0) continue;
    const counts = VALID_FAILURE_KINDS.map(
      (kind) => records.filter((record) => record.checks.valid?.kind === kind).length,
    );
    lines.push(`| \`${caseId}\` | ${counts.join(" | ")} |`);
    const byDetail = new Map<string, number>();
    for (const record of records) {
      const detail = cell(record.checks.valid?.detail ?? "");
      byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1);
    }
    for (const [detail, count] of byDetail) {
      reasons.push(`- \`${caseId}\`, ${count} of ${records.length}: ${detail}`);
    }
  }
  return [...lines, "", ...reasons, ""];
}

function erroredLines(report: EvalSummary): string[] {
  const { errored } = report.summary;
  const lines: string[] = [];
  if (report.aborted) lines.push(`**The run stopped early.** ${report.aborted}`, "");
  if (errored.total > 0) {
    const auth =
      errored.auth > 0
        ? `, ${errored.auth} of them because the provider rejected the API key`
        : "";
    lines.push(
      `**Errored turns: ${errored.total} of ${report.scorecard.headline.turns}**${auth}. They are not the model's answers, so no check judged them; each is listed under its run below.`,
      "",
    );
  }
  return lines;
}

/**
 * Everything in a report that is a number: its run, the scorecard, a
 * baseline comparison if given, and the pass rates per check and per case.
 * No reply, proposal or failure reason, so it can be committed.
 */
function numberLines(
  report: EvalSummary,
  title: string,
  baseline?: MarkdownBaseline,
): string[] {
  return [
    `# ${title}`,
    "",
    `- Run: ${report.generatedAt}`,
    `- Model: \`${report.model}\``,
    `- Tactics: ${tacticsText(report.tactics)}`,
    `- Prompt version: \`${report.promptVersion}\``,
    `- Tool set version: ${report.toolsetVersion}`,
    `- Runs per case: ${report.runsPerCase}; cases: ${report.caseIds.length}; turns: ${report.scorecard.headline.turns}; errored turns: ${report.summary.errored.total}`,
    "",
    "Pass rates count the proposals a check could judge. A reply with no proposal, or one that did not apply, fails check 1 and is not judged by checks 2 to 5 or 7. A turn that errored (the provider or the transport failed, or it timed out) is not judged by any check and is counted apart. Check 6 is judged on extreme cases only, and check 7 on the sketch cases only (the ones that name the parts they ask for). Check 8 judges every case: a proposal, or, where the case expects one, a question and no proposal; a case that expects a question is judged by checks 1 to 7 only if it proposed something anyway. Checks 16 and 20 judge every proposal that applied, because a proposal that stops partway (notes cleared and never written, a clip made and never placed) applies cleanly and passes the rest; the other checks from 9 on are judged only on the cases that name them, and 18 and 19 judge the basic production actions. Nothing gates on the descriptive numbers.",
    "",
    ...erroredLines(report),
    ...headlineLines(report.scorecard),
    ...setLines(report.scorecard),
    ...heavySetLines(report.scorecard, baseline?.heavy),
    ...(baseline ? comparisonLines(baseline.comparisons, baseline.label) : []),
    ...secondaryLines(report.scorecard),
    "## Pass rate per check",
    "",
    "| Check | Pass rate |",
    "| --- | --- |",
    ...CHECK_IDS.map(
      (id) => `| ${CHECK_LABELS[id]} | ${formatTally(report.summary.checks[id])} |`,
    ),
    "",
    "## By case",
    "",
    `| Case | ${CHECK_IDS.map((id) => CHECK_LABELS[id].split(".")[0]).join(" | ")} | Errored |`,
    `| --- | ${CHECK_IDS.map(() => "---").join(" | ")} | --- |`,
    ...report.caseIds.map((caseId) => {
      const tallies = report.summary.cases[caseId] ?? {};
      const cells = CHECK_IDS.map((id: CheckId) => {
        const tally = tallies[id];
        return tally ? `${tally.pass}/${tally.pass + tally.fail}` : "-";
      });
      return `| \`${caseId}\` | ${cells.join(" | ")} | ${report.summary.errored.cases[caseId] ?? 0} |`;
    }),
    "",
    ...caseSecondaryLines(report.scorecard),
  ];
}

/** The numbers alone: what `summary.md` holds, and what a committed baseline is. */
export function renderSummaryMarkdown(
  report: EvalSummary,
  title = "Assistant musical capability evals: summary",
): string {
  return `${numberLines(report, title).join("\n").trimEnd()}\n`;
}

export function renderMarkdown(report: EvalReport, baseline?: MarkdownBaseline): string {
  const lines: string[] = [
    ...numberLines(report, "Assistant musical capability evals", baseline),
    ...validFailureLines(report),
    ...sessionLines(report.records),
    "## Runs",
  ];
  for (const caseId of report.caseIds) {
    const records = report.records.filter((record) => record.caseId === caseId);
    const first = records[0];
    if (!first) continue;
    lines.push(
      "",
      `### \`${caseId}\` (${first.capability}, ${first.axis})`,
      "",
      `> ${first.request}`,
      "",
    );
    for (const record of records) {
      if (record.error) {
        lines.push(
          `**Run ${record.run}** (${Math.round(record.durationMs / 1000)} s): errored, not judged: ${cell(record.error)}`,
          ...(tokensLine(record) ? ["", `- ${tokensLine(record)}`] : []),
          "",
        );
        continue;
      }
      lines.push(
        `**Run ${record.run}** (${Math.round(record.durationMs / 1000)} s${record.firstTextMs != null ? `, first text ${Math.round(record.firstTextMs / 1000)} s` : ""}${record.firstPartMs != null ? `, first part ${Math.round(record.firstPartMs / 1000)} s` : ""}, stop: ${record.stopReason ?? "none"}): ${statsLine(record)}`,
      );
      lines.push("");
      const tokensText = tokensLine(record);
      if (tokensText) lines.push(`- ${tokensText}`);
      for (const id of CHECK_IDS) {
        const result = record.checks[id];
        if (result && result.status === "fail") {
          lines.push(`- ${CHECK_LABELS[id]} failed: ${cell(result.detail)}`);
        }
      }
      if (record.text) {
        const said = record.text.trim().replace(/\s+/g, " ");
        lines.push(`- Said: "${said.length > 400 ? `${said.slice(0, 400)}...` : said}"`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
