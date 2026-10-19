/**
 * What an experiment does with its verdict (GRV-110): it posts the report on
 * its card, and on a win opens one PR labelled `hold` that makes the winning
 * improve's tactic values, and every cut's that kept together, production's
 * defaults, and commits the report as `docs/experiments/<id>.md`. On no win
 * or an inconclusive one there is no PR, just the comment. A PR that fails to
 * open is said so in the comment, which is posted regardless. Then the card
 * moves on the board: Ready For Review on a win, Done on no win, Blocked
 * otherwise. The board started the run when the PR that built the experiment
 * merged, and left the card In Progress until now (`board.mjs pr`).
 *
 * The PR's changes are worked out here, as plain file contents, so they are
 * tested without git: each winning tactic's `default:` line in
 * `src/assistant/tactics.ts` is rewritten, and the prompt or tool set version
 * is bumped where the tactic says it alters them (`TacticDefinition.alters`).
 * The script hands in the real comment poster and PR opener; tests hand in
 * recorders, so no test ever opens a PR.
 */
import type { TacticDefinition, TacticSurface } from "../tactics";
import { CONTROL, type ExperimentVariant } from "./experiment";
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

/** The run's time as a branch suffix: `20261018-155520`. */
function stamp(generatedAt: string): string {
  return generatedAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-").toLowerCase();
}

/** What a win lands: the improve that won, if any, then every cut that kept. */
export function landedVariants(result: ExperimentResult): ExperimentVariant[] {
  return [
    ...(result.winner && result.winner.name !== CONTROL ? [result.winner] : []),
    ...result.keptCuts,
  ];
}

/** The PR a win opens; null for an experiment without one. */
export function planWinPullRequest(
  result: ExperimentResult,
  options: WinPlanOptions,
): WinPullRequest | null {
  const { winner, experiment } = result;
  const landed = landedVariants(result);
  if (result.verdict !== "win" || landed.length === 0) return null;
  const overrides: Record<string, string> = Object.assign(
    {},
    ...landed.map((variant) => variant.overrides),
  );
  let tactics = options.readFile(TACTICS_PATH);
  const surfaces = new Set<TacticSurface>();
  for (const [id, value] of Object.entries(overrides)) {
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
  const values = Object.entries(overrides)
    .map(([id, value]) => `${id}=${value}`)
    .join(", ");
  const gate = winner && result.gates.find((entry) => entry.variant === winner.name);
  const train =
    winner && result.trainAnalyses.find((entry) => entry.variant === winner.name);
  const card = experiment.card.toLowerCase();
  const cuts = result.keptCuts;
  const body = [
    "## What & why",
    "",
    `Experiment \`${experiment.id}\` ${winner ? "found a win" : "kept cuts"}, so this makes these tactic values production's defaults: ${values}.`,
    "",
    `> ${experiment.hypothesis}`,
    "",
    ...(winner
      ? [
          `The improve \`${winner.name}\` (${variantTactics(winner)}) won:`,
          "",
          ...(train ? [`- Train: ${goalLine(train)}`] : []),
          ...(gate ? [`- Held out: ${goalLine(gate.analysis)}`] : []),
          "- Every guardrail held on both.",
          "",
        ]
      : []),
    ...(cuts.length > 0
      ? [
          `${cuts.length === 1 ? "The cut" : "The cuts"} ${cuts.map((cut) => `\`${cut.name}\` (${variantTactics(cut)})`).join(", ")} held the bar on train and held-out${cuts.length > 1 ? ", alone and together" : ""}, no worse than the control beyond noise.`,
          "",
          ...result.cuts
            .filter((cut) => cut.verdict === "restore")
            .map((cut) => `- Restored, not in this PR: \`${cut.name}\`. ${cut.why}`),
          ...(result.cuts.some((cut) => cut.verdict === "restore") ? [""] : []),
        ]
      : []),
    `It changes the defaults in \`${TACTICS_PATH}\`${bumps.length > 0 ? `, bumps ${bumps.join(" and ")} because the tactic alters them,` : ""} and commits the report as \`${experimentDocPath(experiment.id)}\`.`,
    "",
    `Completes ${experiment.card}`,
    "",
    `Labelled \`${HOLD_LABEL}\`: production takes the new defaults only when the product owner decides. Merging it puts the card in QA, which tests the new defaults on production.`,
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
    // One branch per run, so a second win of the same experiment never collides.
    branch: `claude/${card}-experiment-${experiment.id}-${stamp(result.generatedAt)}`,
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
  /** Moves the card to the board column the verdict leaves it in. */
  readonly moveCard: (card: string, state: CardState) => Promise<void>;
}

/** The board columns an experiment's verdict moves its card to. */
export type CardState = "Ready For Review" | "Done" | "Blocked";

/**
 * Where the card goes once the report is up. A win waits in Ready For Review
 * on its held PR; no win is the card's answer, so it is Done; an inconclusive
 * run, or a win whose PR did not open, needs the product owner, so Blocked.
 */
export function cardStateAfter(
  verdict: ExperimentResult["verdict"],
  pullRequestUrl: string | null,
): CardState {
  if (verdict === "no win") return "Done";
  if (verdict === "win" && pullRequestUrl) return "Ready For Review";
  return "Blocked";
}

export interface Concluded {
  readonly markdown: string;
  readonly pullRequestUrl: string | null;
  /** Why the win's PR did not open, or null when it did or there was none. */
  readonly pullRequestError: string | null;
  readonly commentUrl: string | null;
  readonly cardState: CardState;
}

/**
 * Opens the win's PR, if there is one, then posts the report (linking it, or
 * saying why it did not open) on the card and moves the card
 * ({@link cardStateAfter}). Returns the report as posted and
 * what was opened; a PR that failed to open is in `pullRequestError`, so the
 * caller can fail the run after the comment is up.
 */
export async function concludeExperiment(
  result: ExperimentResult,
  publisher: ExperimentPublisher,
  options: WinPlanOptions,
): Promise<Concluded> {
  let pullRequestUrl: string | null = null;
  let pullRequestError: string | null = null;
  try {
    const plan = planWinPullRequest(result, options);
    if (plan) pullRequestUrl = await publisher.openPullRequest(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pullRequestError = message.replace(/\s+/g, " ").trim().slice(0, 500);
  }
  const markdown = renderExperimentMarkdown(result, {
    ...options.links,
    pullRequestUrl,
    pullRequestError,
  });
  const commentUrl = await publisher.postComment(result.experiment.card, markdown);
  const cardState = cardStateAfter(result.verdict, pullRequestUrl);
  await publisher.moveCard(result.experiment.card, cardState);
  return { markdown, pullRequestUrl, pullRequestError, commentUrl, cardState };
}
