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
 *                         and approves the open PRs of every card in Approved.
 *   node board.mjs pr     On a pull_request event: a PR that closes a card
 *                         puts it in QA (or Ready For Review when it changes the
 *                         security rules); the PR that completes a card merging
 *                         puts it in QA; the PR that closes a card merging puts
 *                         it in Done.
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
import { approvalOfIssue, approve, lineStatus, openPrs, refersTo } from "./merge.mjs";

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
      if (!/@claude\b/i.test(c.body) || c.body.startsWith(PICKUP)) continue;
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

async function poll() {
  const index = openPrs();
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
}

// ---------------------------------------------------------------- pr

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
    // PRs without an approval): production is QA'd after the deploy. The PR
    // that closes a card (the preview path) was QA'd before it merged.
    for (const id of completedBy(p.body)) await move(id, "QA");
    for (const id of closedBy(p.body)) await move(id, "Done");
    return;
  }
  if (event.action === "closed" || p.draft) return;
  // A PR that closes a card puts it in QA (its preview is QA'd), unless it
  // changes the security rules: those never get a preview, so the QA bot never
  // sees them, and the card goes straight to review.
  const target = changesRules(p.number) ? "Ready For Review" : "QA";
  for (const id of closedBy(p.body)) await move(id, target);
}

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
