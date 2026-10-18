/**
 * `bun run assistant:experiment <id>`: runs one assistant experiment
 * (GRV-110), `evals/experiments/<id>.ts`, through the evals offline.
 *
 * Every variant runs against the **live model** through the gateway's own
 * turn, on fixture projects, in one interleaved pass on the experiment's
 * train cases; a variant that wins there reruns beside the control on the
 * held-out cases. Nothing touches production traffic, user data, Firestore
 * or the deployed gateway's quota. The framework is
 * `src/assistant/evals/experiment*.ts`; this file only wires it to the
 * provider, the disk, Linear and GitHub.
 *
 *   bun run assistant:experiment -- thinking-effort-low
 *   bun run assistant:experiment -- <id> --budget 10   stop at $10 (default $25)
 *   bun run assistant:experiment -- <id> --runs 2      runs per train case (default the experiment's)
 *   bun run assistant:experiment -- <id> --no-post     write the report; post and open nothing
 *   bun run assistant:experiment -- <id> --out DIR     where the report goes
 *
 * It needs ANTHROPIC_API_KEY (and says so, calling nothing, without it). It
 * writes `experiment.md` and `experiment.json`, and each phase's variant
 * reports under `train/<variant>/` and `gate/<variant>/`, to
 * `tmp/assistant-experiments/<id>-<time>/` unless `--out` says otherwise.
 * Then, unless `--no-post`:
 *
 * - on a **win** it opens one PR labelled `hold` from a new branch off the
 *   commit it ran on (`git` and `gh`, so `GH_TOKEN` must be able to push and
 *   open PRs) that makes the winner's tactic values the defaults and commits
 *   the report as `docs/experiments/<id>.md`;
 * - either way it posts the report on the experiment's card
 *   (`.github/scripts/linear.mjs`, which needs `LINEAR_API_KEY`; without it
 *   the comment is skipped, and said so).
 *
 * It exits 1 when the key was refused, the account ran out of credit, or
 * every turn errored; a "no win" is a finding, not a failure.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAnthropicProvider } from "../functions/src/anthropicProvider";
import { ASSISTANT_MODELS } from "../src/assistant/config";
import { EvalUsageError, requireApiKey } from "../src/assistant/evals/cli";
import { recordLines } from "../src/assistant/evals/consoleOutput";
import { ExperimentError, loadExperiment } from "../src/assistant/evals/experiment";
import { parseExperimentArgs } from "../src/assistant/evals/experimentCli";
import {
  concludeExperiment,
  type ExperimentPublisher,
  type WinPullRequest,
} from "../src/assistant/evals/experimentPr";
import {
  type ExperimentLinks,
  experimentJson,
  renderExperimentMarkdown,
} from "../src/assistant/evals/experimentReport";
import {
  type ExperimentPhase,
  type ExperimentResult,
  experimentExitCode,
  gatewayTurnRunner,
  runExperiment,
} from "../src/assistant/evals/experimentRun";
import { renderMarkdown } from "../src/assistant/evals/markdown";
import { TACTICS } from "../src/assistant/tactics";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Where the run is, as the report links it. */
function linksFromEnvironment(): ExperimentLinks {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA } = process.env;
  let commit = GITHUB_SHA ?? null;
  if (!commit) {
    try {
      commit = git("rev-parse", "HEAD");
    } catch {
      commit = null;
    }
  }
  return {
    runUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : null,
    commit,
  };
}

async function writePhase(dir: string, phase: ExperimentPhase): Promise<void> {
  for (const [variant, report] of Object.entries(phase.reports)) {
    const out = join(dir, phase.phase, variant);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "report.md"), renderMarkdown(report));
  }
}

async function writeResult(
  dir: string,
  result: ExperimentResult,
  links: ExperimentLinks,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "experiment.json"),
    `${JSON.stringify(experimentJson(result, links), null, 2)}\n`,
  );
  await writeFile(join(dir, "experiment.md"), renderExperimentMarkdown(result, links));
  await writePhase(dir, result.train);
  for (const gate of result.gates) await writePhase(dir, gate.phase);
}

/** Posts on the card through the one Linear client, if it has a key. */
async function postComment(card: string, body: string): Promise<string | null> {
  if (!process.env.LINEAR_API_KEY) {
    console.log(`\nLINEAR_API_KEY is not set, so the report was not posted on ${card}.`);
    return null;
  }
  const scratch = await mkdtemp(join(tmpdir(), "experiment-comment-"));
  try {
    const file = join(scratch, "comment.md");
    await writeFile(file, body);
    const posted = execFileSync(
      "node",
      [".github/scripts/linear.mjs", "comment", card, "--body-file", file],
      { encoding: "utf8" },
    );
    const url = (JSON.parse(posted) as { url?: string }).url ?? null;
    console.log(`\nPosted the report on ${card}${url ? `: ${url}` : ""}`);
    return url;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Opens the win's PR: a branch off this commit, one commit, pushed, `gh pr create`. */
async function openPullRequest(plan: WinPullRequest): Promise<string> {
  git("switch", "-c", plan.branch);
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  git("add", "--", ...plan.files.map((file) => file.path));
  git("commit", "-m", plan.commitMessage);
  git("push", "-u", "origin", plan.branch);
  const scratch = await mkdtemp(join(tmpdir(), "experiment-pr-"));
  try {
    const bodyFile = join(scratch, "body.md");
    await writeFile(bodyFile, plan.body);
    const url = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        plan.branch,
        "--title",
        plan.title,
        "--body-file",
        bodyFile,
        ...plan.labels.flatMap((label) => ["--label", label]),
      ],
      { encoding: "utf8" },
    ).trim();
    console.log(`\nOpened ${url}, labelled ${plan.labels.join(", ")}`);
    return url;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const SKIPPED: ExperimentPublisher = {
  postComment: async (card) => {
    console.log(`\n--no-post: the report was not posted on ${card}.`);
    return null;
  },
  openPullRequest: async (plan) => {
    console.log(`\n--no-post: no PR opened (it would be ${plan.branch}: ${plan.title}).`);
    return `(not opened: ${plan.branch})`;
  },
};

async function main(): Promise<number> {
  try {
    const parsed = parseExperimentArgs(process.argv.slice(2), process.env);
    if (parsed.kind === "help") {
      console.log(parsed.text);
      return 0;
    }
    const { options } = parsed;
    // Checked before the key, so a typo in the file costs nothing.
    const experiment = await loadExperiment(options.id);
    const apiKey = requireApiKey(process.env, {
      name: "Assistant experiments",
      example: `bun run assistant:experiment -- ${options.id}`,
    });
    const model = ASSISTANT_MODELS[options.model];
    console.log(
      `Experiment ${experiment.id} (${experiment.card}): ${experiment.variants.map((variant) => variant.name).join(" vs ")} on ${experiment.train.length} train cases against ${model.id}, a $${options.budgetUsd} budget...`,
    );
    const result = await runExperiment(experiment, {
      runTurn: gatewayTurnRunner({
        provider: createAnthropicProvider({ apiKey }),
        model,
        turnTimeoutMs: options.turnTimeoutMs,
      }),
      model,
      budgetUsd: options.budgetUsd,
      concurrency: options.concurrency,
      ...(options.runs === null ? {} : { runs: options.runs }),
      onRecord: (phase, variant, record) => {
        for (const line of recordLines(record))
          console.log(`[${phase} ${variant}] ${line}`);
      },
    });
    const links = linksFromEnvironment();
    const dir =
      options.out ??
      join(
        "tmp",
        "assistant-experiments",
        `${experiment.id}-${result.generatedAt.replace(/[:.]/g, "-")}`,
      );
    await writeResult(dir, result, links);
    const concluded = await concludeExperiment(
      result,
      options.noPost ? SKIPPED : { postComment, openPullRequest },
      {
        readFile: (path) =>
          execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }),
        tactics: TACTICS,
        links,
        day: result.generatedAt.slice(0, 10),
      },
    );
    // The posted copy links the PR; keep that one.
    await writeFile(join(dir, "experiment.md"), concluded.markdown);
    console.log(`\nVerdict: ${result.verdict}. ${result.reason}`);
    console.log(
      `Spend: $${result.spentUsd.toFixed(2)} of $${options.budgetUsd.toFixed(2)}`,
    );
    console.log(
      `Report: ${join(dir, "experiment.md")} and ${join(dir, "experiment.json")}`,
    );
    return experimentExitCode(result);
  } catch (error) {
    if (error instanceof EvalUsageError || error instanceof ExperimentError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main();
