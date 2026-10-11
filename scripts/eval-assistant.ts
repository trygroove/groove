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
 *   bun run eval:assistant -- --replay <report.json>
 *       re-judge a saved report's proposals with the current checks (no model call)
 *
 * It needs ANTHROPIC_API_KEY in the environment and says so, making no call,
 * when it is missing. Each run writes `report.json` (every request, reply,
 * proposal and check) and `report.md` (pass rate per check, then per case) to
 * `tmp/assistant-evals/<time>/` unless `--out` says otherwise.
 *
 * A turn that errored (the provider refused or failed, or it timed out) is
 * counted apart and judged by no check. If the provider rejects the key it
 * stops at once and says so; it exits 1 then, and whenever every turn errored.
 * The parsing and the key guard live in `src/assistant/evals/cli.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAnthropicProvider } from "../functions/src/anthropicProvider";
import { ASSISTANT_MODELS } from "../src/assistant/config";
import { CHECK_IDS, CHECK_LABELS } from "../src/assistant/evals/checks";
import {
  type EvalCliOptions,
  EvalUsageError,
  parseEvalArgs,
  requireApiKey,
  selectEvalCases,
} from "../src/assistant/evals/cli";
import {
  formatTally,
  renderMarkdown,
  validFailureLine,
} from "../src/assistant/evals/markdown";
import {
  buildReport,
  type EvalRecord,
  type EvalReport,
  evalExitCode,
  evaluateRecords,
  runEvals,
} from "../src/assistant/evals/run";

async function writeReport(report: EvalReport, out: string | null): Promise<string> {
  const dir =
    out ?? join("tmp", "assistant-evals", report.generatedAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), renderMarkdown(report));
  return dir;
}

function printSummary(report: EvalReport, dir: string): void {
  const { errored } = report.summary;
  console.log(
    `\nModel ${report.model}, prompt ${report.promptVersion}, ${report.records.length} turns, ${errored.total} errored`,
  );
  for (const id of CHECK_IDS) {
    console.log(
      `  ${CHECK_LABELS[id].padEnd(36)} ${formatTally(report.summary.checks[id])}`,
    );
  }
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

/** One line per run: a mark per check, and why it errored or failed check 1. */
function printRecord(record: EvalRecord): void {
  const marks = CHECK_IDS.map((id) => {
    const status = record.checks[id]?.status;
    return status === "pass"
      ? "+"
      : status === "fail"
        ? "x"
        : status === "skip"
          ? "."
          : " ";
  }).join("");
  const valid = validFailureLine(record);
  console.log(
    `  [${record.error ? "errored" : marks}] ${record.caseId} run ${record.run}${record.error ? ` (${record.error})` : ""}${valid ? ` (check 1: ${valid})` : ""}`,
  );
}

async function replay(path: string, options: EvalCliOptions): Promise<EvalReport> {
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
  printSummary(report, await writeReport(report, options.out));
  return report;
}

async function live(options: EvalCliOptions): Promise<EvalReport> {
  const cases = selectEvalCases(options.caseIds);
  const apiKey = requireApiKey(process.env);
  const model = ASSISTANT_MODELS[options.model];
  console.log(
    `Running ${cases.length} cases x ${options.runs} runs against ${model.id} (the live model)...`,
  );
  const report = await runEvals({
    provider: createAnthropicProvider({ apiKey }),
    model,
    cases,
    runs: options.runs,
    concurrency: options.concurrency,
    turnTimeoutMs: options.turnTimeoutMs,
    onRecord: printRecord,
  });
  printSummary(report, await writeReport(report, options.out));
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
