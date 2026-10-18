/**
 * What an experiment does with its verdict (GRV-110): it posts the report on
 * its card, and on a win opens one PR labelled `hold` that makes the winning
 * tactic values production's defaults and commits the report as
 * `docs/experiments/<id>.md`. On no win or an inconclusive one there is no
 * PR, just the comment.
 *
 * The PR's changes are worked out here, as plain file contents, so they are
 * tested without git: each winning tactic's `default:` line in
 * `src/assistant/tactics.ts` is rewritten, and the prompt or tool set version
 * is bumped where the tactic says it alters them (`TacticDefinition.alters`).
 * The script hands in the real comment poster and PR opener; tests hand in
 * recorders, so no test ever opens a PR.
 */
import type { TacticDefinition, TacticSurface } from "../tactics";
import { CONTROL } from "./experiment";
import {
  type ExperimentLinks,
  goalLine,
  renderExperimentMarkdown,
  variantTactics,
} from "./experimentReport";
import type { ExperimentResult } from "./experimentRun";

export const TACTICS_PATH = "src/assistant/tactics.ts";
export const PROMPT_PATH = "src/assistant/prompt.ts";
export const TOOLS_PATH = "src/assistant/tools.ts";

/** Where a win commits its report. */
export function experimentDocPath(id: string): string {
  return `docs/experiments/${id}.md`;
}

/** The label that keeps a win's PR out of the merge queue until the product owner decides. */
export const HOLD_LABEL = "hold";

/**
 * `source` (the tactic registry) with tactic `id`'s default set to `value`.
 * Throws if it has no entry for `id` with a `default:` line of its own.
 */
export function setTacticDefault(source: string, id: string, value: string): string {
  const entry = new RegExp(`\\n(\\s+)${id}: \\{\\n`).exec(source);
  if (!entry) throw new Error(`${TACTICS_PATH} has no entry for the tactic ${id}`);
  const indent = entry[1];
  const start = entry.index + entry[0].length;
  const end = source.indexOf(`\n${indent}},`, start);
  if (end < 0) throw new Error(`The ${id} entry in ${TACTICS_PATH} does not close`);
  const body = source.slice(start, end);
  const line = /^(\s+default: )"[^"\n]*",$/m;
  if (!line.test(body)) {
    throw new Error(`The ${id} entry in ${TACTICS_PATH} has no default: "..." line`);
  }
  return `${source.slice(0, start)}${body.replace(line, `$1${JSON.stringify(value)},`)}${source.slice(end)}`;
}

/**
 * `source` (`prompt.ts`) with `ASSISTANT_PROMPT_VERSION` moved on: the next
 * number of `day` if it is already that day's, else `day.1`.
 */
export function bumpPromptVersion(source: string, day: string): string {
  const pattern =
    /(export const ASSISTANT_PROMPT_VERSION = ")(\d{4}-\d{2}-\d{2})\.(\d+)(";)/;
  const match = pattern.exec(source);
  if (!match) throw new Error(`${PROMPT_PATH} has no ASSISTANT_PROMPT_VERSION to bump`);
  const next = match[2] === day ? `${day}.${Number(match[3]) + 1}` : `${day}.1`;
  return source.replace(pattern, `$1${next}$4`);
}

/** `source` (`tools.ts`) with `ASSISTANT_TOOLSET_VERSION` one higher. */
export function bumpToolsetVersion(source: string): string {
  const pattern = /(export const ASSISTANT_TOOLSET_VERSION = )(\d+)(;)/;
  const match = pattern.exec(source);
  if (!match) throw new Error(`${TOOLS_PATH} has no ASSISTANT_TOOLSET_VERSION to bump`);
  return source.replace(pattern, `$1${Number(match[2]) + 1}$3`);
}

/** One file a PR writes, whole. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/** Everything a win's PR is: its branch, its commit, its files, its text and its label. */
export interface WinPullRequest {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  readonly labels: readonly string[];
  readonly files: readonly PlannedFile[];
}

export interface WinPlanOptions {
  /** Reads a file of the commit the experiment ran on, by repository path. */
  readonly readFile: (path: string) => string;
  /** The tactics the winner's values are checked against; the registry by default. */
  readonly tactics: Readonly<Record<string, TacticDefinition>>;
  readonly links: ExperimentLinks;
  /** Today, `YYYY-MM-DD`, for a prompt version bump. */
  readonly day: string;
}

/** The PR a win opens; null for an experiment without one. */
export function planWinPullRequest(
  result: ExperimentResult,
  options: WinPlanOptions,
): WinPullRequest | null {
  const { winner, experiment } = result;
  if (result.verdict !== "win" || !winner || winner.name === CONTROL) return null;
  let tactics = options.readFile(TACTICS_PATH);
  const surfaces = new Set<TacticSurface>();
  for (const [id, value] of Object.entries(winner.overrides)) {
    tactics = setTacticDefault(tactics, id, value);
    for (const surface of options.tactics[id]?.alters ?? []) surfaces.add(surface);
  }
  const files: PlannedFile[] = [{ path: TACTICS_PATH, content: tactics }];
  const bumps: string[] = [];
  if (surfaces.has("prompt")) {
    files.push({
      path: PROMPT_PATH,
      content: bumpPromptVersion(options.readFile(PROMPT_PATH), options.day),
    });
    bumps.push("`ASSISTANT_PROMPT_VERSION`");
  }
  if (surfaces.has("tools") || surfaces.has("expansion")) {
    files.push({
      path: TOOLS_PATH,
      content: bumpToolsetVersion(options.readFile(TOOLS_PATH)),
    });
    bumps.push("`ASSISTANT_TOOLSET_VERSION`");
  }
  const report = renderExperimentMarkdown(result, options.links);
  files.push({ path: experimentDocPath(experiment.id), content: report });
  const values = Object.entries(winner.overrides)
    .map(([id, value]) => `${id}=${value}`)
    .join(", ");
  const gate = result.gates.find((entry) => entry.variant === winner.name);
  const train = result.trainAnalyses.find((entry) => entry.variant === winner.name);
  const card = experiment.card.toLowerCase();
  const body = [
    "## What & why",
    "",
    `Experiment \`${experiment.id}\` found a win, so this makes \`${winner.name}\`'s tactic values production's defaults: ${variantTactics(winner)}.`,
    "",
    `> ${experiment.hypothesis}`,
    "",
    ...(train ? [`- Train: ${goalLine(train)}`] : []),
    ...(gate ? [`- Held out: ${goalLine(gate.analysis)}`] : []),
    "- Every guardrail held on both.",
    "",
    `It changes the defaults in \`${TACTICS_PATH}\`${bumps.length > 0 ? `, bumps ${bumps.join(" and ")} because the tactic alters them,` : ""} and commits the report as \`${experimentDocPath(experiment.id)}\`.`,
    "",
    `Refs ${experiment.card}`,
    "",
    `Labelled \`${HOLD_LABEL}\`: production takes the new defaults only when the product owner decides.`,
    "",
    "## Screenshots",
    "",
    "No UI change.",
    "",
    "## Evidence",
    "",
    `- Run: ${options.links.runUrl ?? "a local run"}`,
    `- Commit the variants ran against: ${options.links.commit ? `\`${options.links.commit}\`` : "unknown"}`,
    `- Spend: $${result.spentUsd.toFixed(2)} of a $${result.budgetUsd.toFixed(2)} budget`,
    `- The full report: \`${experimentDocPath(experiment.id)}\``,
    "",
    "---",
    "_Opened by `bun run assistant:experiment` (GRV-110)._",
    "",
  ].join("\n");
  return {
    branch: `claude/${card}-experiment-${experiment.id}`,
    title: `Implement ${experiment.card}: Default to ${values} (experiment ${experiment.id})`,
    body,
    commitMessage: `Default to ${values}: experiment ${experiment.id} won (${experiment.card})`,
    labels: [HOLD_LABEL],
    files,
  };
}

/** What the script hands in to post and open things; tests hand in recorders. */
export interface ExperimentPublisher {
  /** Posts `body` as a comment on the card. Resolves with the comment's URL, if there is one. */
  readonly postComment: (card: string, body: string) => Promise<string | null>;
  /** Opens the PR. Resolves with its URL. */
  readonly openPullRequest: (plan: WinPullRequest) => Promise<string>;
}

export interface Concluded {
  readonly markdown: string;
  readonly pullRequestUrl: string | null;
  readonly commentUrl: string | null;
}

/**
 * Opens the win's PR, if there is one, then posts the report (linking it) on
 * the card. Returns the report as posted and what was opened.
 */
export async function concludeExperiment(
  result: ExperimentResult,
  publisher: ExperimentPublisher,
  options: WinPlanOptions,
): Promise<Concluded> {
  const plan = planWinPullRequest(result, options);
  const pullRequestUrl = plan ? await publisher.openPullRequest(plan) : null;
  const markdown = renderExperimentMarkdown(result, { ...options.links, pullRequestUrl });
  const commentUrl = await publisher.postComment(result.experiment.card, markdown);
  return { markdown, pullRequestUrl, commentUrl };
}
