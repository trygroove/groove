/**
 * `bun run eval:assistant`: the assistant's musical capability evals (GRV-6).
 *
 * Runs every case in `src/assistant/evals/cases.ts` (or the ones named) N
 * times against the **live model**, through the gateway's own turn with the
 * production system prompt and tool schema, on fixture projects only. It
 * never touches user data, Firestore or the deployed gateway's quota. On
 * demand only: by hand or from the Actions tab (`.github/workflows/eval-assistant.yml`),
 * never in per-push CI and never on a schedule.
 *
 *   bun run eval:assistant                       every case, 3 runs each
 *   bun run eval:assistant -- sketch-house       one case (or several)
 *   bun run eval:assistant -- --runs 5           N runs per case
 *   bun run eval:assistant -- --model claude-haiku-4-5
 *   bun run eval:assistant -- --out tmp/evals    where the report goes
 *   bun run eval:assistant -- --timeout 180      per-turn limit in seconds (default 540, production's)
 *   bun run eval:assistant -- --steps 1          steps a turn may take (default production's; 1 is one call)
 *   bun run eval:assistant -- --replay <report.json>
 *       re-judge a saved report's proposals with the current checks (no model call)
 *   bun run eval:assistant -- --baseline docs/assistant-eval-baseline.json
 *       print every scorecard number beside the baseline's, with its delta
 *   bun run eval:assistant -- --from-transcript <transcript-<turn>.json>
 *       run a kept turn the admin transcript viewer downloaded as the one case
 *       (GRV-98): its message against the fixture the file names
 *
 * It needs ANTHROPIC_API_KEY in the environment and says so, making no call,
 * when it is missing. Each run writes `report.json` (every request, reply,
 * proposal and check), `report.md` (the scorecard (GRV-102), then the pass
 * rate per check and per case, then every run), and `summary.json` and
 * `summary.md` (the numbers alone, no replies: what a committed baseline is)
 * to `tmp/assistant-evals/<time>/` unless `--out` says otherwise.
 *
 * A turn that errored (the provider refused or failed, or it timed out) is
 * counted apart and judged by no check. If the provider rejects the key it
 * stops at once and says so; it exits 1 then, and whenever every turn errored.
 * The parsing and the key guard live in `src/assistant/evals/cli.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAnthropicProvider } from "../functions/src/anthropicProvider";
import { ASSISTANT_MAX_STEPS, ASSISTANT_MODELS } from "../src/assistant/config";
import { evalCaseFromTranscript } from "../src/assistant/evals/cases";
import { CHECK_IDS, CHECK_LABELS } from "../src/assistant/evals/checks";
import {
  type EvalCliOptions,
  EvalUsageError,
  type LoadedBaseline,
  loadBaseline,
  parseEvalArgs,
  requireApiKey,
  selectEvalCases,
} from "../src/assistant/evals/cli";
import { failureDigestLines, recordLines } from "../src/assistant/evals/consoleOutput";
import {
  formatTally,
  type MarkdownBaseline,
  renderMarkdown,
  renderSummaryMarkdown,
} from "../src/assistant/evals/markdown";
import {
  buildReport,
  type EvalRecord,
  type EvalReport,
  evalExitCode,
  evaluateRecords,
  runEvals,
  summaryOf,
} from "../src/assistant/evals/run";
import { compareScorecards } from "../src/assistant/evals/scorecard";
import {
  comparisonConsoleLines,
  formatRate,
} from "../src/assistant/evals/scorecardMarkdown";
import { parseTranscriptCase } from "../src/assistant/evals/transcriptCase";

async function readBaseline(path: string | null): Promise<LoadedBaseline | null> {
  if (!path) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new EvalUsageError(
      `Could not read the baseline ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return loadBaseline(saved, path);
}

function comparedTo(
  report: EvalReport,
  baseline: LoadedBaseline | null,
): MarkdownBaseline | undefined {
  if (!baseline) return undefined;
  return {
    label: baseline.label,
    comparisons: compareScorecards(report.scorecard, baseline.scorecard),
  };
}

async function writeReport(
  report: EvalReport,
  out: string | null,
  baseline: MarkdownBaseline | undefined,
): Promise<string> {
  const dir =
    out ?? join("tmp", "assistant-evals", report.generatedAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), renderMarkdown(report, baseline));
  const summary = summaryOf(report);
  await writeFile(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(dir, "summary.md"), renderSummaryMarkdown(summary));
  return dir;
}

function printSummary(
  report: EvalReport,
  dir: string,
  baseline: MarkdownBaseline | undefined,
): void {
  const { errored } = report.summary;
  const { headline, secondary } = report.scorecard;
  console.log(
    `\nModel ${report.model}, prompt ${report.promptVersion}, ${report.records.length} turns, ${errored.total} errored`,
  );
  console.log(
    `\nHeadline: applies ${formatRate(headline.applies)}, overall ${formatRate(headline.overall)}, expected outcome ${formatRate(headline.expectMatch)}`,
  );
  for (const id of CHECK_IDS) {
    console.log(
      `  ${CHECK_LABELS[id].padEnd(36)} ${formatTally(report.summary.checks[id])}`,
    );
  }
  if (baseline) {
    console.log(
      `\nAgainst ${baseline.label.path} (${baseline.label.model}, prompt ${baseline.label.promptVersion}):`,
    );
    for (const line of comparisonConsoleLines(baseline.comparisons)) console.log(line);
  } else {
    const cost = secondary.costUsd.total;
    console.log(
      `\nLatency p50 ${secondary.latencyMs.p50 ?? "n/a"} ms, p95 ${secondary.latencyMs.p95 ?? "n/a"} ms; cost ${cost === null ? "n/a" : `$${cost.toFixed(4)}`}`,
    );
  }
  for (const line of failureDigestLines(report)) console.log(line);
  if (errored.total > 0) {
    console.log(
      `\n${errored.total} of ${report.records.length} turns errored and were judged by no check.`,
    );
  }
  if (errored.auth > 0) {
    console.error(
      "\nThe provider rejected the API key (HTTP 401/403). Check ANTHROPIC_API_KEY.",
    );
  }
  if (report.aborted) console.error(`\nThe run stopped early: ${report.aborted}`);
  console.log(`\nReport: ${join(dir, "report.md")} and ${join(dir, "report.json")}`);
}

/** One line per run naming its calls, then a line per check it failed. */
function printRecord(record: EvalRecord): void {
  for (const line of recordLines(record)) console.log(line);
}

async function replay(path: string, options: EvalCliOptions): Promise<EvalReport> {
  const baseline = await readBaseline(options.baseline);
  const saved = JSON.parse(await readFile(path, "utf8")) as EvalReport;
  const cases = selectEvalCases(saved.caseIds as string[]);
  const records = evaluateRecords(saved.records as EvalRecord[], cases);
  for (const record of records) printRecord(record);
  const report = buildReport(records, cases, {
    generatedAt: new Date().toISOString(),
    model: saved.model,
    promptVersion: saved.promptVersion,
    toolsetVersion: saved.toolsetVersion,
    runsPerCase: saved.runsPerCase,
    aborted: saved.aborted ?? null,
  });
  const compared = comparedTo(report, baseline);
  printSummary(report, await writeReport(report, options.out, compared), compared);
  return report;
}

/** The cases to run: the transcript file's one case, or the named ones. */
async function casesFor(options: EvalCliOptions) {
  if (!options.fromTranscript) return selectEvalCases(options.caseIds);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(options.fromTranscript, "utf8"));
  } catch (error) {
    throw new EvalUsageError(
      `Couldn't read ${options.fromTranscript}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseTranscriptCase(raw);
  if (!parsed.ok) {
    throw new EvalUsageError(
      `${options.fromTranscript} is not a transcript case from the admin viewer: ${parsed.message}`,
    );
  }
  const { recorded } = parsed.value;
  const rejection = recorded.outcomes.findLast((entry) => entry.outcome === "rejected");
  console.log(
    `Transcript ${parsed.value.turnId}: ${recorded.calls.length} recorded calls${rejection ? `, rejected (${rejection.issues?.map((issue) => issue.code).join(", ") ?? "no issues kept"})` : ""}; running against the ${parsed.value.fixture} fixture.`,
  );
  return [evalCaseFromTranscript(parsed.value)];
}

async function live(options: EvalCliOptions): Promise<EvalReport> {
  const cases = await casesFor(options);
  const apiKey = requireApiKey(process.env);
  // Read before the run, so a bad path costs no model calls.
  const baseline = await readBaseline(options.baseline);
  const model = ASSISTANT_MODELS[options.model];
  console.log(
    `Running ${cases.length} cases x ${options.runs} runs against ${model.id} (the live model), up to ${options.maxSteps ?? ASSISTANT_MAX_STEPS} steps a turn...`,
  );
  const report = await runEvals({
    provider: createAnthropicProvider({ apiKey }),
    model,
    cases,
    runs: options.runs,
    concurrency: options.concurrency,
    turnTimeoutMs: options.turnTimeoutMs,
    ...(options.maxSteps === null ? {} : { maxSteps: options.maxSteps }),
    onRecord: printRecord,
  });
  const compared = comparedTo(report, baseline);
  printSummary(report, await writeReport(report, options.out, compared), compared);
  return report;
}

async function main(): Promise<number> {
  try {
    const parsed = parseEvalArgs(process.argv.slice(2), process.env);
    if (parsed.kind === "help") {
      console.log(parsed.text);
      return 0;
    }
    const { options } = parsed;
    const report = options.replay
      ? await replay(options.replay, options)
      : await live(options);
    return evalExitCode(report);
  } catch (error) {
    if (error instanceof EvalUsageError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main();
