#!/usr/bin/env node
/**
 * The board lives in Linear (team GRV, the Groove project); this is what makes
 * moving a card there do something. Run by `.github/workflows/board.yml`.
 *
 *   node board.mjs poll   On each card move and every 15 min (the relay). Reads the columns and writes to
 *                         $GITHUB_OUTPUT the work each one asks for:
 *                           ship=["GRV-12", …]      cards in Ready with no open blocker, at most
 *                                                   SHIP_PER_POLL (4) of them in priority order
 *                                                   (moved to In Progress here)
 *                           rework=[{issue,prs,comment}, …]  cards sent back to In Progress with PRs open
 *                                                   (sent back with none open and no merged PR that
 *                                                   completes it, the card is unfinished: it joins ship,
 *                                                   and /ship continues from its handoff)
 *                           mentions=[{issue,comment,reply}, …]  comments that say @claude
 *                           milestone=["GRV-40", …] new bugs with no milestone
 *                         and approves the open PRs of every card in Approved. Before
 *                         that, a card in Blocked, Ready For Review or Approved whose
 *                         /ship handoff waits on a PR that has merged goes back to
 *                         Ready (and joins ship); after it, the idle sweep moves a
 *                         card that has sat in In Progress for an hour with no ship,
 *                         rework, mention or claude.yml run on it, and no PR of it
 *                         queued, auto-merging with CI green or running, or running
 *                         an assistant experiment, to Blocked (or to Ready For Review
 *                         when its PRs are healthy and only wait for approval), with
 *                         a comment naming its PRs and their state (GRV-197).
 *   node board.mjs pr     On a pull_request event: a PR that closes a card
 *                         puts it in QA (or Ready For Review when it changes the
 *                         security rules); the PR that completes a card merging
 *                         puts it in QA, unless it adds or changes that card's
 *                         assistant experiment (`evals/experiments/<id>.ts`):
 *                         then it starts the experiment and the card stays In
 *                         Progress until the verdict moves it; the PR that
 *                         closes a card merging puts it in Done. Any merged PR a
 *                         card's /ship handoff waits on puts that card back in Ready.
 *
 * Nothing here needs a cursor or a webhook. Every rule reads the card's own
 * state and the comments on it, so a poll that runs twice does the work once:
 * Ready is left as soon as it is seen, and a run announces itself on the card
 * (a "Picking this up" comment) before its agent starts, which is what the
 * next poll sees. The product owner only ever moves cards and comments; the
 * automation moves them on. See CLAUDE.md, "The board", and docs/linear.md.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import * as linear from "./linear.mjs";
import {
  approvalOfIssue,
  approve,
  GATE_JOBS,
  issuesIn,
  lineStatus,
  openPrs,
  refersTo,
} from "./merge.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const RUN_URL = process.env.RUN_URL ?? "";
/** Builds a poll may start: the rest of Ready waits for the next poll. */
const SHIP_PER_POLL = Number(process.env.SHIP_PER_POLL ?? 4);

/** The first line of the comment a run leaves on a card when it starts. */
export const PICKUP = "**Picking this up";
const PICKUP_SHIP = `${PICKUP}.** ([/ship run](${RUN_URL}))`;
const PICKUP_REWORK = `${PICKUP} again: it was sent back while its PRs were open.** ([rework run](${RUN_URL}))`;
const PICKUP_CONTINUE = `${PICKUP} again: it was sent back with work left and no PR open.** ([/ship run](${RUN_URL}))`;
const PICKUP_MENTION = `${PICKUP}.** ([run](${RUN_URL}))`;
const PLACEHOLDER =
  "_Reading the issue and working out a plan; this comment will show it and track progress._";

const TRANSIENT =
  /HTTP (5\d\d|429)|No server is currently available|secondary rate limit|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset/i;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `gh`, retrying transient GitHub failures; any other failure throws at once. */
const gh = (args, input) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      if (stderr) process.stderr.write(stderr);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !TRANSIENT.test(stderr)) throw error;
      console.warn(
        `gh ${args[0]} ${args[1] ?? ""}: transient failure, retrying in ${delay / 1000}s`,
      );
      sleep(delay);
    }
  }
};

const output = (name, value) => {
  const line = `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
};

/**
 * Cards a PR body closes: "Closes GRV-12", "fixes GRV-3", "Resolves GRV-45".
 * Code spans and blocks are skipped: a body that quotes "`Closes GRV-12`" as
 * an example does not close GRV-12.
 */
const prose = (body) =>
  (body ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
export const closedBy = (body) =>
  [
    ...prose(body).matchAll(
      new RegExp(
        `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(${linear.TEAM_KEY}-\\d+)\\b`,
        "gi",
      ),
    ),
  ].map((m) => m[1].toUpperCase());

/** Cards a PR body completes (`Completes GRV-12`): the card goes to QA when it merges, and QA moves it to Done. */
export const completedBy = (body) =>
  [
    ...prose(body).matchAll(
      new RegExp(`\\bcompletes?\\s+(${linear.TEAM_KEY}-\\d+)\\b`, "gi"),
    ),
  ].map((m) => m[1].toUpperCase());

const RULES_FILES = new Set(["firestore.rules", "storage.rules"]);

function changesRules(pr) {
  try {
    const { files } = JSON.parse(
      gh(["pr", "view", String(pr), "--repo", REPO, "--json", "files"]),
    );
    return files.some((f) => RULES_FILES.has(f.path));
  } catch {
    // If the files can't be read, assume the normal path: QA.
    return false;
  }
}

/**
 * True when a merged PR completes or closes the card, so nothing is left to
 * build. When GitHub can't be asked, say so: starting a build on a guess is
 * worse than waiting for the next poll.
 */
function completedOnMain(identifier) {
  try {
    const bodies = JSON.parse(
      gh([
        "api",
        "-X",
        "GET",
        "search/issues",
        "-f",
        `q=repo:${REPO} is:pr is:merged "${identifier}" in:body`,
        "--jq",
        "[.items[].body]",
      ]),
    );
    return bodies.some((b) => [...completedBy(b), ...closedBy(b)].includes(identifier));
  } catch {
    console.warn(
      `${identifier}: could not search its merged PRs; assuming it is finished`,
    );
    return true;
  }
}

// ---------------------------------------------------------------- poll

const REWORK_GRACE_MS = 15 * 60 * 1000;
const MILESTONE_WINDOW_MS = 6 * 60 * 60 * 1000;

const latest = (comments, test) =>
  comments.filter(test).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

/** The last time the card entered In Progress, or null. */
const enteredInProgress = (issue) =>
  issue.history
    .filter((h) => h.toState?.name.toLowerCase() === "in progress")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

async function pollReady() {
  const ship = [];
  // Stop the line: no new build starts while CI is red on main (merge.mjs).
  const line = lineStatus();
  if (line.stopped) {
    console.log(`The line is stopped (CI red on main: ${line.url}); starting no builds`);
    return ship;
  }
  for (const card of linear.startOrder(await linear.list({ state: "Ready" }))) {
    if (ship.length >= SHIP_PER_POLL) {
      console.log(
        `${card.identifier}: Ready; waiting, ${SHIP_PER_POLL} builds started this poll`,
      );
      continue;
    }
    // A card blocked by work that has not merged stays in Ready, and starts on
    // the first poll after its last blocker reaches QA.
    const blockers = linear.openBlockers(card);
    if (blockers.length) {
      console.log(
        `${card.identifier}: Ready; waiting on ${blockers.map((b) => `${b.identifier} (${b.state.name})`).join(", ")}`,
      );
      continue;
    }
    // Leave Ready first: the next poll must not see this card again.
    await linear.setState(card.identifier, "In Progress");
    const c = await linear.comment(card.identifier, `${PICKUP_SHIP}\n\n${PLACEHOLDER}`);
    ship.push({ issue: card.identifier, comment: c.id });
    console.log(`${card.identifier}: Ready → In Progress; shipping`);
  }
  return ship;
}

async function pollApproved(index) {
  for (const card of await linear.list({ state: "Approved" })) {
    const prs = approvalOfIssue(card.identifier, index);
    if (prs.length) approve(prs, index);
  }
}

/**
 * A card moved to In Progress (from QA, review, Approved or Blocked) was sent
 * back for more work, unless it just came from Ready (that is /ship starting)
 * or Backlog (not agreed yet), or a run has already announced itself on it
 * since the move. With PRs open, a rework run fixes them, unless an `@claude`
 * comment on one of them in the last 15 minutes means a Claude run is already
 * on it (the CI-failure handler's is one). With none open, the card is
 * unfinished when no merged PR completes it (a sequence stopped at a gated PR,
 * say), and /ship continues it from its handoff; a finished card, such as one
 * that failed QA, is left to the `@claude` run QA started.
 */
async function pollRework(index, ship) {
  const rework = [];
  const now = Date.now();
  const line = lineStatus();
  for (const card of await linear.list({
    state: "In Progress",
    history: true,
    comments: true,
  })) {
    const moved = enteredInProgress(card);
    const from = moved?.fromState?.name.toLowerCase();
    if (!moved || from === "ready" || from === "backlog") continue;
    const announced = latest(
      card.comments,
      (c) => c.body.startsWith(PICKUP) && c.createdAt > moved.createdAt,
    );
    if (announced) continue;
    const prs = index.prs.filter((p) => refersTo(p.body, card.identifier));
    if (!prs.length) {
      if (line.stopped || completedOnMain(card.identifier)) continue;
      const c = await linear.comment(
        card.identifier,
        `${PICKUP_CONTINUE}\n\n${PLACEHOLDER}`,
      );
      ship.push({ issue: card.identifier, comment: c.id });
      console.log(
        `${card.identifier}: sent back from ${moved.fromState?.name ?? "?"} with no PR open and none completing it; continuing /ship`,
      );
      continue;
    }
    const handled = prs.some((pr) =>
      (pr.comments ?? []).some(
        (c) =>
          c.body.includes("@claude") && now - Date.parse(c.createdAt) < REWORK_GRACE_MS,
      ),
    );
    if (handled) continue;
    const c = await linear.comment(card.identifier, `${PICKUP_REWORK}\n\n${PLACEHOLDER}`);
    rework.push({
      issue: card.identifier,
      prs: prs.map((p) => p.number).join(" "),
      comment: c.id,
    });
    console.log(
      `${card.identifier}: sent back from ${moved.fromState?.name ?? "?"} with PRs ${rework.at(-1).prs}; reworking`,
    );
  }
  return rework;
}

/**
 * The first words of every comment the board and the CI-failure workflow
 * write on a card. Those report what the automation did; none of them asks
 * for a run, so a mention of Claude in one is never a request.
 */
export const AUTOMATED = [
  PICKUP,
  "**Moved to Blocked",
  "**Moved to Ready For Review",
  "**Back to Ready.**",
];

/** Whether a card comment asks for a Claude run: it says `@claude`, and a person wrote it. */
export const mentionRequest = (body) =>
  /@claude\b/i.test(body) && !AUTOMATED.some((prefix) => body.startsWith(prefix));

/**
 * A comment that says `@claude` starts a Claude run on the card, once: the
 * poll replies "Picking this up" under it before the run starts, and a
 * comment that already has that reply is done. The run keeps its progress in
 * that reply.
 */
async function pollMentions() {
  const mentions = [];
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  for (const card of await linear.list({ open: true, comments: true })) {
    if (card.updatedAt < since) continue;
    for (const c of card.comments) {
      if (!mentionRequest(c.body)) continue;
      const replies = card.comments.filter((r) => r.parent?.id === c.id);
      if (replies.some((r) => r.body.startsWith(PICKUP))) continue;
      const reply = await linear.comment(
        card.identifier,
        `${PICKUP_MENTION}\n\n${PLACEHOLDER}`,
        { replyTo: c.id },
      );
      mentions.push({ issue: card.identifier, comment: c.id, reply: reply.id });
      console.log(`${card.identifier}: @claude in comment ${c.id}; starting a run`);
    }
  }
  return mentions;
}

/** New bugs with no milestone: a short Claude run puts each on the milestone of its area. */
async function pollMilestones() {
  const since = new Date(Date.now() - MILESTONE_WINDOW_MS).toISOString();
  const bugs = await linear.list({
    labels: ["bug"],
    noMilestone: true,
    createdAfter: since,
  });
  return bugs.map((b) => b.identifier);
}

// ---------------------------------------------------------------- handoff

/** The first line of the comment /ship leaves on a card when a sequence stops part way. */
export const HANDOFF = "**Handoff from /ship";
/**
 * The columns a handoff leaves a card in: Blocked, Ready For Review once the
 * PR it waits for is gated (merge.mjs moves the card there), or Approved once
 * the product owner approves that PR.
 */
const HANDOFF_COLUMNS = new Set(["blocked", "ready for review", "approved"]);

/**
 * The PR a card's /ship handoff waits for, when that is all that holds it
 * back: the card is in Blocked (or Ready For Review, or Approved), its
 * latest handoff's first line says "Waiting on #<n>", and it has not been
 * back to Ready since. A handoff
 * that waits on a decision (the PR was closed unmerged) names no PR.
 */
export function handoffAwaiting(card) {
  if (!HANDOFF_COLUMNS.has(card.state?.name.toLowerCase())) return null;
  const note = latest(card.comments, (c) => c.body.startsWith(HANDOFF));
  if (!note) return null;
  const resumed = card.history.some(
    (h) => h.toState?.name.toLowerCase() === "ready" && h.createdAt > note.createdAt,
  );
  if (resumed) return null;
  const pr = note.body.split("\n")[0].match(/waiting on #(\d+)/i);
  return pr ? Number(pr[1]) : null;
}

/** Back to Ready, where the poll starts /ship, which continues from the handoff. */
async function resumeHandoff(card, number) {
  await linear.setState(card.identifier, "Ready");
  await linear.comment(
    card.identifier,
    `**Back to Ready.** #${number}, which the /ship handoff was waiting on, has merged, so /ship continues from the handoff.`,
  );
  console.log(
    `${card.identifier}: #${number} merged; ${card.state?.name ?? "?"} → Ready to continue /ship`,
  );
}

/**
 * The backstop for the merge event (`board.mjs pr`): a card whose handoff
 * waits on a PR that has merged goes back to Ready.
 */
async function pollHandoffs() {
  const resumed = [];
  for (const card of await linear.list({
    state: ["Blocked", "Ready For Review", "Approved"],
    history: true,
    comments: true,
  })) {
    const number = handoffAwaiting(card);
    if (!number) continue;
    let merged;
    try {
      merged = gh([
        "api",
        `repos/${REPO}/pulls/${number}`,
        "--jq",
        ".merged_at // empty",
      ]);
    } catch {
      console.warn(`${card.identifier}: could not read #${number}; leaving it`);
      continue;
    }
    if (!merged) continue;
    await resumeHandoff(card, number);
    resumed.push(card.identifier);
  }
  return resumed;
}

// ---------------------------------------------------------------- sweep

/**
 * In Progress means an agent is working on the card. One left there with
 * nothing happening for this long, and nothing running for it, goes to Blocked.
 */
const IDLE_MS = 60 * 60 * 1000;
/** The workflows whose runs count as an agent on a card. */
const WATCHED = {
  board: "board.yml",
  claude: "claude.yml",
  experiment: "assistant-experiments.yml",
};
const EXPERIMENT_STARTED = "**Experiment started.**";
const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

const names = (text, identifier) =>
  new RegExp(`\\b${identifier}(?!\\d)`).test(text ?? "");
const hasLabel = (p, name) => (p.labels ?? []).some((l) => l.name === name);

/** The experiments the card's "Experiment started" comments name. */
const experimentsStarted = (card) =>
  card.comments
    .filter((c) => c.body.startsWith(EXPERIMENT_STARTED))
    .map((c) => c.body.match(/`([a-z0-9-]+)`/)?.[1])
    .filter(Boolean);

/**
 * True when a running workflow run is an agent on the card: a board.yml run
 * with a ship, rework or mention job for it still going, a claude.yml run on
 * one of its PRs (the run is titled after the PR), or the assistant
 * experiment it started. An experiment run titled only with the workflow's
 * name (one dispatched before runs carried the experiment's ID) counts as the
 * card's: never move a card whose experiment may be going.
 */
export function runFor(run, card, prs) {
  if (run.workflow === "board") return run.jobs.some((j) => names(j, card.identifier));
  if (run.workflow === "claude")
    return names(run.title, card.identifier) || prs.some((p) => p.title === run.title);
  if (run.workflow === "experiment") {
    const ids = experimentsStarted(card);
    if (!ids.length) return false;
    return (
      ids.some((id) => run.title.includes(id)) || !/experiment\s+\S/i.test(run.title)
    );
  }
  return false;
}

/**
 * Where an open PR stands, in words, and whether it is still moving on its
 * own: queued, or auto-merging with its required checks green or still
 * running. A failed required check, a conflict, a draft or a hold all need
 * someone.
 */
export function prActivity(p) {
  const gates = (p.statusCheckRollup ?? []).filter((c) =>
    GATE_JOBS.includes(c.name ?? c.context),
  );
  const failed = gates
    .filter((c) => FAILED.has(c.conclusion ?? c.state))
    .map((c) => c.name ?? c.context);
  const running = gates.some(
    (c) =>
      (c.status && c.status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(c.state),
  );
  const conflict = p.mergeStateStatus === "DIRTY";
  const held = hasLabel(p, "hold");
  const awaitingApproval =
    hasLabel(p, "needs-approval") && !hasLabel(p, "status:approved");
  const parts = [];
  if (p.isDraft) parts.push("a draft");
  if (held) parts.push("labelled `hold`");
  if (awaitingApproval) parts.push("waiting for approval (`needs-approval`)");
  if (conflict) parts.push("conflicts with `main`");
  if (failed.length) parts.push(`CI failed (${failed.join(", ")})`);
  else if (running) parts.push("CI running");
  parts.push(p.autoMergeRequest ? "auto-merge on" : "not queued");
  return {
    inFlight: Boolean(
      p.autoMergeRequest && !p.isDraft && !held && !conflict && !failed.length,
    ),
    // Gated and otherwise healthy: the next step is the product owner's review.
    onlyAwaitingApproval:
      awaitingApproval && !p.isDraft && !held && !conflict && !failed.length,
    state: parts.join(", "),
  };
}

/**
 * What the sweep does with one In Progress card: `leave` it (with why),
 * `review` it (move it to Ready For Review: every open PR of it is healthy
 * and only waits for the product owner's approval) or `block` it (move it to
 * Blocked). `review` and `block` carry the comment to post. `prs` are the
 * open PRs that refer to it, with their checks; `runs` the watched
 * workflows' runs still going.
 */
export function sweepVerdict(card, { now, prs, runs, idleMs = IDLE_MS }) {
  const times = [
    enteredInProgress(card)?.createdAt,
    ...card.comments.flatMap((c) => [c.createdAt, c.updatedAt]),
    ...prs.flatMap((p) =>
      (p.comments ?? [])
        .filter((c) => c.body.includes("@claude"))
        .map((c) => c.createdAt),
    ),
  ]
    .filter(Boolean)
    .map(Date.parse);
  const last = times.length ? Math.max(...times) : 0;
  const idle = Math.round((now - last) / 60_000);
  if (now - last < idleMs)
    return { action: "leave", reason: `last active ${idle} min ago` };
  const run = runs.find((r) => runFor(r, card, prs));
  if (run)
    return { action: "leave", reason: `a ${run.workflow} run is on it (${run.url})` };
  const states = prs.map((p) => ({ p, ...prActivity(p) }));
  const moving = states.find((s) => s.inFlight);
  if (moving)
    return { action: "leave", reason: `#${moving.p.number} is ${moving.state}` };
  const found = states.length
    ? states.map((s) => `- [#${s.p.number}](${s.p.url}): ${s.state}`).join("\n")
    : "- No open PR refers to it.";
  const footer = "---\n_Posted by the board's idle sweep (`.github/scripts/board.mjs`)._";
  if (states.length && states.every((s) => s.onlyAwaitingApproval))
    return {
      action: "review",
      comment: `**Moved to Ready For Review: its PRs wait for approval.** No agent has worked on this card for ${idle} minutes, and every open PR of it touches a gated path and is otherwise ready:

${found}

Review them, then move this card to Approved to land them, or comment what should change and move it to In Progress.

${footer}`,
    };
  return {
    action: "block",
    comment: `**Moved to Blocked: no agent is working on this card.** It sat in In Progress for ${idle} minutes with no /ship, rework or Claude run on it, and no PR of it queued, auto-merging with CI green or running, or running an assistant experiment. What the board found:

${found}

Say what should happen next here. To send an agent back to it, move it to In Progress: a rework run takes on its open PRs, or /ship continues from its handoff when none is open.

${footer}`,
  };
}

/** Every status GitHub gives a workflow run that has not finished. */
const UNFINISHED = ["in_progress", "queued", "waiting", "pending", "requested"];

/**
 * `gh api --paginate` over a list endpoint, with a jq filter that prints one
 * JSON value per line: every line, parsed.
 */
const ghLines = (path, jq) =>
  gh(["api", "--paginate", path, "--jq", jq])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/**
 * The watched workflows' runs that are not finished, with each board run's
 * unfinished jobs. Asks GitHub for each unfinished status in turn rather than
 * filtering the latest runs: board.yml starts a run every few minutes, so a
 * ship job that has been going for hours is far past its first page.
 */
export function activeRuns(list = ghLines) {
  const runs = new Map();
  for (const [workflow, file] of Object.entries(WATCHED)) {
    for (const status of UNFINISHED) {
      for (const r of list(
        `repos/${REPO}/actions/workflows/${file}/runs?status=${status}&per_page=100`,
        ".workflow_runs[] | {id, title: .display_title, url: .html_url}",
      )) {
        if (runs.has(r.id)) continue;
        const jobs =
          workflow === "board"
            ? list(
                `repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`,
                '.jobs[] | select(.status != "completed") | .name',
              )
            : [];
        runs.set(r.id, { workflow, ...r, jobs });
      }
    }
  }
  return [...runs.values()];
}

const prChecks = (number) =>
  JSON.parse(
    gh([
      "pr",
      "view",
      String(number),
      "--repo",
      REPO,
      "--json",
      "title,url,statusCheckRollup,mergeStateStatus",
    ]),
  );

/**
 * The backstop: a card in In Progress with no agent on it and nothing moving
 * for it for an hour goes to Blocked (or to Ready For Review, when every open
 * PR of it only waits for approval), with a comment naming its PRs and where
 * each stands. Cards this poll just handed to a run are skipped, and nothing
 * is swept while the line is stopped (every PR is out of the queue then, and
 * rejoins it on its own) or when GitHub cannot say what is running.
 */
async function pollSweep(index, skip) {
  if (lineStatus().stopped) return console.log("The line is stopped; not sweeping");
  let runs;
  try {
    runs = activeRuns();
  } catch {
    return console.warn("Could not list the running workflows; not sweeping");
  }
  const now = Date.now();
  for (const card of await linear.list({
    state: "In Progress",
    history: true,
    comments: true,
  })) {
    if (skip.has(card.identifier)) continue;
    let prs;
    try {
      prs = index.prs
        .filter((p) => refersTo(p.body, card.identifier))
        .map((p) => ({ ...p, ...prChecks(p.number) }));
    } catch {
      console.warn(`${card.identifier}: could not read its PRs' checks; leaving it`);
      continue;
    }
    const verdict = sweepVerdict(card, { now, prs, runs });
    if (verdict.action === "leave") {
      console.log(`${card.identifier}: In Progress; ${verdict.reason}`);
      continue;
    }
    // The list is from the start of the sweep: someone may have moved the card since.
    const current = await linear.issue(card.identifier, { comments: false });
    if (current?.state?.name !== "In Progress") {
      console.log(
        `${card.identifier}: now ${current?.state?.name ?? "gone"}; leaving it`,
      );
      continue;
    }
    const target = verdict.action === "review" ? "Ready For Review" : "Blocked";
    await linear.setState(card.identifier, target);
    await linear.comment(card.identifier, verdict.comment);
    console.log(
      `${card.identifier}: idle in In Progress with no agent on it; → ${target}`,
    );
  }
}

// ---------------------------------------------------------------- retried CI

/** How long a re-run's own completion gets to start ci-failure.yml before the poll steps in. */
const RETRY_GRACE_MS = 10 * 60 * 1000;
const CI_FAILURE = new URL("./ci-failure.sh", import.meta.url).pathname;

/**
 * The PR CI runs (pull_request) the poll hands to `ci-failure.sh pr`: failed
 * again on a re-run, finished more than RETRY_GRACE_MS ago, from the branch
 * of an open PR. ci-failure.sh re-runs a failed PR run with GITHUB_TOKEN,
 * and GitHub may start no workflow for that re-run's completion, so without
 * this the PR would never be handed to a Claude run. The script acts on a
 * run once, so a run its workflow did handle is left alone there.
 */
export function retriedRuns(runs, prs, now) {
  const branches = new Set(prs.map((p) => p.headRefName));
  return runs.filter(
    (r) =>
      r.attempt > 1 &&
      branches.has(r.branch) &&
      now - Date.parse(r.updatedAt) > RETRY_GRACE_MS,
  );
}

/** Hand each retried red PR run to ci-failure.sh. Returns the cards of the PRs it looked at. */
function pollRetriedRuns(index) {
  const now = Date.now();
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const runs = ghLines(
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&status=failure&created=${encodeURIComponent(`>=${since}`)}&per_page=100`,
    ".workflow_runs[] | {id, branch: .head_branch, sha: .head_sha, attempt: .run_attempt, updatedAt: .updated_at}",
  );
  const cards = new Set();
  for (const r of retriedRuns(runs, index.prs, now)) {
    const p = index.prs.find((x) => x.headRefName === r.branch);
    for (const id of issuesIn(p.body)) cards.add(id);
    try {
      execFileSync(
        "bash",
        [CI_FAILURE, "pr", String(r.id), r.branch, r.sha, String(r.attempt)],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    } catch {
      console.warn(`#${p.number}: ci-failure.sh could not handle run ${r.id}`);
    }
  }
  return cards;
}

async function poll() {
  const index = openPrs();
  const resumed = await pollHandoffs();
  const ship = await pollReady();
  await pollApproved(index);
  const rework = await pollRework(index, ship);
  const mentions = await pollMentions();
  const milestone = await pollMilestones();
  output("ship", ship);
  output("rework", rework);
  output("mentions", mentions);
  output("milestone", milestone);
  output(
    "any",
    ship.length + rework.length + mentions.length + milestone.length > 0
      ? "true"
      : "false",
  );
  // After the outputs: the runs this poll starts must start even if these fail.
  let retried = new Set();
  try {
    retried = pollRetriedRuns(index);
  } catch (error) {
    console.warn(`Could not check the re-run PR CI runs: ${error.message}`);
  }
  const skip = new Set([
    ...retried,
    ...resumed,
    ...ship.map((s) => s.issue),
    ...rework.map((r) => r.issue),
    ...mentions.map((m) => m.issue),
  ]);
  try {
    await pollSweep(index, skip);
  } catch (error) {
    console.warn(`The idle sweep failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------- pr

const EXPERIMENTS = "assistant-experiments.yml";
const EXPERIMENT_FILE = /^evals\/experiments\/([a-z0-9-]+)\.ts$/;

/**
 * The assistant experiments (GRV-110) a merged PR added or changed, each with
 * the card its file names (`card: "GRV-12"`), read at the merge commit.
 */
function experimentsIn(p) {
  const experiments = [];
  let files;
  try {
    files = gh([
      "api",
      "--paginate",
      `repos/${REPO}/pulls/${p.number}/files`,
      "--jq",
      '.[] | select(.status != "removed") | .filename',
    ]).split("\n");
  } catch {
    return experiments;
  }
  const card = new RegExp(`\\bcard:\\s*["'](${linear.TEAM_KEY}-\\d+)["']`);
  for (const file of files) {
    const id = file.match(EXPERIMENT_FILE)?.[1];
    if (!id) continue;
    try {
      const source = gh([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${REPO}/contents/${file}?ref=${p.merge_commit_sha}`,
      ]);
      const named = source.match(card)?.[1];
      if (named) experiments.push({ id, card: named });
    } catch (error) {
      console.log(`${file}: could not read it at the merge (${error.message})`);
    }
  }
  return experiments;
}

/**
 * Starts the experiment on main, in the Assistant experiments workflow, and
 * says so on its card. The card stays In Progress: the run's verdict moves it
 * (Ready For Review on a win, Done on no win, Blocked otherwise), since QA has
 * nothing to test on production until a win's held PR lands. A run that cannot
 * be started blocks the card instead. The dispatch uses DISPATCH_TOKEN (the
 * job's own token, which may start workflows) where it is set.
 */
async function startExperiment({ id, card }) {
  const runs = `https://github.com/${REPO}/actions/workflows/${EXPERIMENTS}`;
  try {
    execFileSync(
      "gh",
      [
        "workflow",
        "run",
        EXPERIMENTS,
        "--repo",
        REPO,
        "--ref",
        "main",
        "-f",
        `experiment=${id}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GH_TOKEN: process.env.DISPATCH_TOKEN || process.env.GH_TOKEN,
        },
      },
    );
  } catch (error) {
    await linear.comment(
      card,
      `**Experiment not started.** \`${id}\` merged, but the Assistant experiments workflow could not be started (${String(
        error.stderr ?? error.message,
      )
        .trim()
        .slice(
          0,
          300,
        )}). Run it from the [Actions tab](${runs}) with experiment \`${id}\` on \`main\`.`,
    );
    await move(card, "Blocked");
    return;
  }
  await linear.comment(
    card,
    `**Experiment started.** \`${id}\` is running against the live model on \`main\` ([Assistant experiments](${runs})). Its verdict goes on this card and moves it: Ready For Review on a win (the held PR with the new defaults), Done on no win, Blocked when inconclusive.`,
  );
  console.log(`${card}: started experiment ${id}`);
}

async function move(identifier, state) {
  const card = await linear.issue(identifier, { comments: false });
  if (!card) return console.log(`${identifier}: no such card`);
  if (["completed", "canceled", "duplicate"].includes(card.state.type))
    return console.log(`${identifier}: already ${card.state.name}`);
  await linear.setState(identifier, state);
  console.log(`${identifier}: → ${state}`);
}

async function pr() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const p = event.pull_request;
  if (p.merged) {
    // The PR that completes a card merged on its own (merge.yml queues safe
    // PRs without an approval): production is QA'd after the deploy, unless
    // the card is an assistant experiment, whose verdict is its test. The PR
    // that closes a card (the preview path) was QA'd before it merged.
    const completed = completedBy(p.body);
    const experiments = completed.length
      ? experimentsIn(p).filter((e) => completed.includes(e.card))
      : [];
    for (const experiment of experiments) await startExperiment(experiment);
    for (const id of completed) {
      if (!experiments.some((e) => e.card === id)) await move(id, "QA");
    }
    for (const id of closedBy(p.body)) await move(id, "Done");
    // An earlier PR of a sequence merged: a card whose /ship handoff waits on
    // it goes back to Ready, and /ship continues from the handoff.
    for (const id of new Set(issuesIn(p.body))) {
      const card = await linear.issue(id, { history: true });
      if (card && handoffAwaiting(card) === p.number) await resumeHandoff(card, p.number);
    }
    return;
  }
  if (event.action === "closed" || p.draft) return;
  // A PR that closes a card puts it in QA (its preview is QA'd), unless it
  // changes the security rules: those never get a preview, so the QA bot never
  // sees them, and the card goes straight to review.
  const target = changesRules(p.number) ? "Ready For Review" : "QA";
  for (const id of closedBy(p.body)) await move(id, target);
}

// Run only as a script: the tests import the rules above without polling.
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const run = mode === "poll" ? poll : mode === "pr" ? pr : null;
  if (!run) {
    console.error("usage: board.mjs poll|pr");
    process.exit(2);
  }
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
