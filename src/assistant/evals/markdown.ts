/**
 * The Markdown summary of an assistant eval run (GRV-6): the pass rate per
 * check, a case-by-check grid, why check 1 failed in each case, every
 * failure with its reason, and the
 * descriptive numbers per run. The JSON report beside it keeps everything,
 * every proposal included; this is the page a human reads first.
 */
import { CHECK_IDS, CHECK_LABELS, type CheckId, type ValidFailureKind } from "./checks";
import type { EvalRecord, EvalReport, Tally } from "./run";

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

function erroredLines(report: EvalReport): string[] {
  const { errored } = report.summary;
  const lines: string[] = [];
  if (report.aborted) lines.push(`**The run stopped early.** ${report.aborted}`, "");
  if (errored.total > 0) {
    const auth =
      errored.auth > 0
        ? `, ${errored.auth} of them because the provider rejected the API key`
        : "";
    lines.push(
      `**Errored turns: ${errored.total} of ${report.records.length}**${auth}. They are not the model's answers, so no check judged them; each is listed under its run below.`,
      "",
    );
  }
  return lines;
}

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [
    "# Assistant musical capability evals",
    "",
    `- Run: ${report.generatedAt}`,
    `- Model: \`${report.model}\``,
    `- Prompt version: \`${report.promptVersion}\``,
    `- Tool set version: ${report.toolsetVersion}`,
    `- Runs per case: ${report.runsPerCase}; cases: ${report.caseIds.length}; turns: ${report.records.length}; errored turns: ${report.summary.errored.total}`,
    "",
    "Pass rates count the proposals a check could judge. A reply with no proposal, or one that did not apply, fails check 1 and is not judged by checks 2 to 5. A turn that errored (the provider or the transport failed, or it timed out) is not judged by any check and is counted apart. Check 6 is judged on extreme cases only. Nothing gates on the descriptive numbers.",
    "",
    ...erroredLines(report),
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
    ...validFailureLines(report),
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
          "",
        );
        continue;
      }
      lines.push(
        `**Run ${record.run}** (${Math.round(record.durationMs / 1000)} s, stop: ${record.stopReason ?? "none"}): ${statsLine(record)}`,
      );
      lines.push("");
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
