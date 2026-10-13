#!/usr/bin/env node
/**
 * The one Linear client: a thin GraphQL layer over `LINEAR_API_KEY`, used by
 * every workflow script (`board.mjs`, `merge.mjs`, `ci-failure.sh`, the QA
 * sweep's `file.mjs`) and, as a CLI, by the agents a run starts. Issues live
 * in Linear (team `GRV`, the Groove project); GitHub keeps the code, the PRs
 * and the Actions. See CLAUDE.md, "The board", and `docs/linear.md`.
 *
 *   node .github/scripts/linear.mjs issue GRV-12 [--json]      The issue as Markdown: spec, labels, milestone,
 *                                                              blockers, PR links, every comment (with ids)
 *   node .github/scripts/linear.mjs list --state Ready [--label bug] [--no-milestone] [--json]
 *   node .github/scripts/linear.mjs comment GRV-12 --body "…" | --body-file f [--reply-to <comment id>]
 *   node .github/scripts/linear.mjs edit-comment <comment id> --body "…" | --body-file f
 *   node .github/scripts/linear.mjs state GRV-12 "Ready For Review"
 *   node .github/scripts/linear.mjs label GRV-12 bug | unlabel GRV-12 bug
 *   node .github/scripts/linear.mjs milestone GRV-12 "M4: Private Alpha Hardening" | milestones
 *   node .github/scripts/linear.mjs create --title "Bug: …" --body-file f [--label bug]... [--state Backlog]
 *   node .github/scripts/linear.mjs search "tempo field"        Open issues whose title contains the words
 *   node .github/scripts/linear.mjs me
 *
 * Environment: LINEAR_API_KEY (required), LINEAR_TEAM (default GRV),
 * LINEAR_PROJECT (the project's slug id, default f835b9ea1a25).
 */

import { readFileSync } from "node:fs";

export const TEAM_KEY = process.env.LINEAR_TEAM || "GRV";
export const PROJECT_SLUG = process.env.LINEAR_PROJECT || "f835b9ea1a25";
const ENDPOINT = "https://api.linear.app/graphql";

/** The columns, in board order. `type` is Linear's state category. */
export const STATES = [
  { name: "Backlog", type: "backlog", color: "#bec2c8", about: "Not ready to start" },
  {
    name: "Ready",
    type: "unstarted",
    color: "#0e8a16",
    about: "Spec agreed; moving here starts /ship",
  },
  {
    name: "In Progress",
    type: "started",
    color: "#f2c94c",
    about: "An agent is building it",
  },
  {
    name: "Blocked",
    type: "started",
    color: "#b60205",
    about: "Waiting on an answer or decision",
  },
  {
    name: "Ready For Review",
    type: "started",
    color: "#5319e7",
    about: "A gated PR waits for the product owner",
  },
  {
    name: "Approved",
    type: "started",
    color: "#006b75",
    about: "Product owner approved; its PRs are queued to merge",
  },
  {
    name: "QA",
    type: "started",
    color: "#1d76db",
    about: "Merged (or previewed); the QA bot is testing it",
  },
  { name: "Done", type: "completed", color: "#5e6ad2", about: "QA passed on production" },
  { name: "Canceled", type: "canceled", color: "#95a2b3", about: "Not doing it" },
  { name: "Duplicate", type: "duplicate", color: "#95a2b3", about: "Filed twice" },
];

/** `GRV-12` anywhere in text, as a global regex. */
export const idPattern = () => new RegExp(`\\b${TEAM_KEY}-(\\d+)\\b`, "g");
export const isIdentifier = (s) => new RegExp(`^${TEAM_KEY}-\\d+$`).test(s ?? "");

/**
 * A GitHub outage or rate limit, not a real failure: worth another try.
 */
const TRANSIENT =
  /\b(5\d\d|429)\b|rate ?limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one GraphQL document; throws on any GraphQL error, retries transient failures. */
export async function gql(query, variables = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    let res;
    let text;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
      });
      text = await res.text();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await sleep(delay);
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.ok && json && !json.errors) return json.data;
    const message =
      json?.errors?.map((e) => e.message).join("; ") ||
      `${res.status} ${text.slice(0, 300)}`;
    const delay = RETRY_DELAYS_MS[attempt];
    if (
      delay !== undefined &&
      (TRANSIENT.test(String(res.status)) || TRANSIENT.test(message))
    ) {
      console.warn(
        `linear: transient failure (${message}); retrying in ${delay / 1000}s`,
      );
      await sleep(delay);
      continue;
    }
    throw new Error(`Linear: ${message}`);
  }
}

/** Every page of a connection: `select(data)` returns `{ nodes, pageInfo }`. */
export async function paginate(query, variables, select) {
  const all = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const data = await gql(query, { ...variables, after });
    const { nodes, pageInfo } = select(data);
    all.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return all;
}

// ---------------------------------------------------------------- lookups

const cache = {};

export async function team() {
  if (cache.team) return cache.team;
  const data = await gql(
    `query($key:String!){teams(filter:{key:{eq:$key}}){nodes{id key name defaultIssueState{id}}}}`,
    { key: TEAM_KEY },
  );
  const t = data.teams.nodes[0];
  if (!t) throw new Error(`No Linear team with key ${TEAM_KEY}`);
  cache.team = t;
  return t;
}

export async function project() {
  if (cache.project) return cache.project;
  // The slug id is the hex after the name in the project's URL. Matched on
  // the client: it is a handful of projects, and this way the lookup does not
  // depend on which comparators ProjectFilter offers.
  const nodes = await paginate(
    `query($after:String){projects(first:50,after:$after){nodes{id name slugId url}pageInfo{hasNextPage endCursor}}}`,
    {},
    (d) => d.projects,
  );
  const p = nodes.find((x) => x.slugId === PROJECT_SLUG);
  if (!p) throw new Error(`No Linear project with slug id ${PROJECT_SLUG}`);
  cache.project = p;
  return p;
}

/** The team's workflow states by name (case-insensitive). */
export async function states() {
  if (cache.states) return cache.states;
  const data = await gql(
    `query($key:String!){workflowStates(filter:{team:{key:{eq:$key}}},first:50){nodes{id name type position}}}`,
    { key: TEAM_KEY },
  );
  cache.states = data.workflowStates.nodes;
  return cache.states;
}

export async function stateNamed(name) {
  const s = (await states()).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`Team ${TEAM_KEY} has no state named "${name}"`);
  return s;
}

/** Labels the team can use: its own and the workspace's. */
export async function labels() {
  if (cache.labels) return cache.labels;
  cache.labels = await paginate(
    `query($after:String){issueLabels(first:100,after:$after){nodes{id name team{key}}pageInfo{hasNextPage endCursor}}}`,
    {},
    (d) => d.issueLabels,
  );
  cache.labels = cache.labels.filter((l) => !l.team || l.team.key === TEAM_KEY);
  return cache.labels;
}

export async function labelNamed(name, { create = false } = {}) {
  const found = (await labels()).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  if (!create) throw new Error(`No label named "${name}"`);
  const { id } = await team();
  const data = await gql(
    `mutation($input:IssueLabelCreateInput!){issueLabelCreate(input:$input){issueLabel{id name}}}`,
    { input: { name, teamId: id, color: "#95a2b3" } },
  );
  const label = { ...data.issueLabelCreate.issueLabel, team: { key: TEAM_KEY } };
  cache.labels.push(label);
  return label;
}

export async function milestones() {
  const { id } = await project();
  const data = await gql(
    `query($id:String!){project(id:$id){projectMilestones(first:50){nodes{id name sortOrder}}}}`,
    { id },
  );
  return data.project.projectMilestones.nodes;
}

export async function milestoneNamed(name, { create = false } = {}) {
  const found = (await milestones()).find(
    (m) => m.name.toLowerCase() === name.toLowerCase(),
  );
  if (found) return found;
  if (!create) throw new Error(`No project milestone named "${name}"`);
  const { id } = await project();
  const data = await gql(
    `mutation($input:ProjectMilestoneCreateInput!){projectMilestoneCreate(input:$input){projectMilestone{id name}}}`,
    { input: { name, projectId: id } },
  );
  return data.projectMilestoneCreate.projectMilestone;
}

export async function viewer() {
  if (cache.viewer) return cache.viewer;
  cache.viewer = (await gql(`{viewer{id name email}}`)).viewer;
  return cache.viewer;
}

// ---------------------------------------------------------------- issues

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt priority sortOrder
  state{id name type}
  labels{nodes{id name}}
  projectMilestone{id name}
  project{id slugId}
  attachments{nodes{url title}}
  relations{nodes{type relatedIssue{identifier title state{name type}}}}
  inverseRelations{nodes{type issue{identifier title state{name type}}}}
`;

const COMMENT_FIELDS = `id body createdAt updatedAt user{id name} parent{id}`;

/** One issue by identifier (`GRV-12`) or id, with its comments and history. Null if none. */
export async function issue(ref, { comments = true, history = false } = {}) {
  const data = await gql(
    `query($id:String!){issue(id:$id){${ISSUE_FIELDS}
      ${comments ? `comments(first:100){nodes{${COMMENT_FIELDS}}}` : ""}
      ${history ? `history(first:100){nodes{createdAt fromState{name} toState{name} actor{id name}}}` : ""}
    }}`,
    { id: ref },
  ).catch((error) => {
    if (/not found|Entity not found|could not find/i.test(error.message))
      return { issue: null };
    throw error;
  });
  const i = data.issue;
  if (!i) return null;
  return normalise(i);
}

function normalise(i) {
  return {
    ...i,
    labels: i.labels?.nodes.map((l) => l.name) ?? [],
    labelIds: i.labels?.nodes.map((l) => l.id) ?? [],
    attachments: i.attachments?.nodes ?? [],
    comments: i.comments?.nodes ?? [],
    history: i.history?.nodes ?? [],
    // "GRV-3 blocks GRV-12": a relation of type `blocks` on GRV-3 whose relatedIssue
    // is GRV-12; from GRV-12's side it is an inverse relation.
    blockedBy: (i.inverseRelations?.nodes ?? [])
      .filter((r) => r.type === "blocks")
      .map((r) => r.issue),
    blocks: (i.relations?.nodes ?? [])
      .filter((r) => r.type === "blocks")
      .map((r) => r.relatedIssue),
  };
}

/**
 * A blocker stops holding a card back once its work has merged: in QA (merged,
 * being tested on production), Done, or closed some other way. Waiting for
 * Done would hold every step of a sequence on the QA bot.
 */
export const blockerCleared = (blocker) =>
  ["completed", "canceled", "duplicate"].includes(blocker.state?.type) ||
  blocker.state?.name?.toLowerCase() === "qa";

/** The blockers still holding a card back. */
export const openBlockers = (issue) => issue.blockedBy.filter((b) => !blockerCleared(b));

/**
 * Cards in the order to start them: Linear priority (Urgent first, no priority
 * last), then their order in the column on the board.
 */
export function startOrder(cards) {
  const rank = (i) => (i.priority > 0 ? i.priority : 5);
  return [...cards].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder);
}

/**
 * Issues in the team, filtered. `state` is a name or list of names; `labels`
 * must all be present; `noMilestone` keeps only issues with no project
 * milestone; `open` (default) excludes completed, canceled and duplicate states.
 */
export async function list({
  state,
  labels: wanted = [],
  noMilestone = false,
  open = true,
  comments = false,
  history = false,
  createdAfter,
} = {}) {
  const filter = { team: { key: { eq: TEAM_KEY } } };
  // Column names match ignoring case, like stateNamed: "In Progress" is "In progress".
  if (state)
    filter.state = { or: [].concat(state).map((n) => ({ name: { eqIgnoreCase: n } })) };
  else if (open) filter.state = { type: { nin: ["completed", "canceled", "duplicate"] } };
  // One `some` per wanted label: `every` would mean "every label the issue
  // carries is in this set", which is not what an agent asking for `bug` means.
  if (wanted.length)
    filter.and = wanted.map((name) => ({
      labels: { some: { name: { eqIgnoreCase: name } } },
    }));
  if (noMilestone) filter.projectMilestone = { null: true };
  if (createdAfter) filter.createdAt = { gt: createdAfter };
  const nodes = await paginate(
    `query($filter:IssueFilter!,$after:String){issues(filter:$filter,first:50,after:$after,orderBy:updatedAt){nodes{${ISSUE_FIELDS}
      ${comments ? `comments(first:100){nodes{${COMMENT_FIELDS}}}` : ""}
      ${history ? `history(first:100){nodes{createdAt fromState{name} toState{name} actor{id name}}}` : ""}
    }pageInfo{hasNextPage endCursor}}}`,
    { filter },
    (d) => d.issues,
  );
  return nodes.map(normalise);
}

/** Open issues in the team whose title contains every word (case-insensitive). */
export async function search(text) {
  const all = await list({ open: true });
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((i) => words.every((w) => i.title.toLowerCase().includes(w)));
}

/** Create an issue in the team and project. Returns `{ id, identifier, url }`. */
export async function create({
  title,
  body = "",
  state = "Backlog",
  labels: names = [],
  milestone,
  createdAt,
  priority,
}) {
  const t = await team();
  const p = await project();
  const input = {
    teamId: t.id,
    projectId: p.id,
    title,
    description: body,
    stateId: (await stateNamed(state)).id,
  };
  if (names.length) {
    const ids = [];
    for (const n of names) ids.push((await labelNamed(n, { create: true })).id);
    input.labelIds = ids;
  }
  if (milestone)
    input.projectMilestoneId = (await milestoneNamed(milestone, { create: true })).id;
  if (createdAt) input.createdAt = createdAt;
  if (priority !== undefined) input.priority = priority;
  const data = await gql(
    `mutation($input:IssueCreateInput!){issueCreate(input:$input){issue{id identifier url}}}`,
    { input },
  );
  return data.issueCreate.issue;
}

export async function update(ref, input) {
  const i = await issue(ref, { comments: false });
  if (!i) throw new Error(`No issue ${ref}`);
  const data = await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){issue{id identifier state{name}}}}`,
    { id: i.id, input },
  );
  return data.issueUpdate.issue;
}

/** Move an issue to a column. A no-op when it is already there. */
export async function setState(ref, name) {
  const s = await stateNamed(name);
  const i = await issue(ref, { comments: false });
  if (!i) throw new Error(`No issue ${ref}`);
  if (i.state.id === s.id) return i;
  return update(i.id, { stateId: s.id });
}

export async function addLabel(ref, name) {
  const i = await issue(ref, { comments: false });
  const l = await labelNamed(name, { create: true });
  if (i.labelIds.includes(l.id)) return i;
  return update(i.id, { labelIds: [...i.labelIds, l.id] });
}

export async function removeLabel(ref, name) {
  const i = await issue(ref, { comments: false });
  const l = (await labels()).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!l || !i.labelIds.includes(l.id)) return i;
  return update(i.id, { labelIds: i.labelIds.filter((id) => id !== l.id) });
}

export async function setMilestone(ref, name) {
  const m = name ? await milestoneNamed(name) : null;
  return update(ref, { projectMilestoneId: m ? m.id : null });
}

/** Post a comment (or a reply under `replyTo`). Returns `{ id, url }`. */
export async function comment(ref, body, { replyTo, createdAt } = {}) {
  const i = await issue(ref, { comments: false });
  if (!i) throw new Error(`No issue ${ref}`);
  const input = { issueId: i.id, body };
  if (replyTo) input.parentId = replyTo;
  if (createdAt) input.createdAt = createdAt;
  const data = await gql(
    `mutation($input:CommentCreateInput!){commentCreate(input:$input){comment{id url}}}`,
    { input },
  );
  return data.commentCreate.comment;
}

export async function editComment(id, body) {
  const data = await gql(
    `mutation($id:String!,$input:CommentUpdateInput!){commentUpdate(id:$id,input:$input){comment{id url}}}`,
    { id, input: { body } },
  );
  return data.commentUpdate.comment;
}

/**
 * Post an update on the project's status feed (the QA sweep's run summaries).
 * No health is sent, so the project keeps whatever health it was given.
 */
export async function projectUpdate(body) {
  const { id } = await project();
  const data = await gql(
    `mutation($input:ProjectUpdateCreateInput!){projectUpdateCreate(input:$input){projectUpdate{id url}}}`,
    { input: { projectId: id, body } },
  );
  return data.projectUpdateCreate.projectUpdate;
}

/** `blocker` blocks `blocked`. Idempotent. */
export async function relateBlocks(blocker, blocked) {
  const a = await issue(blocker, { comments: false });
  const b = await issue(blocked, { comments: false });
  if (!a || !b) throw new Error(`No issue ${!a ? blocker : blocked}`);
  if (a.blocks.some((x) => x.identifier === b.identifier)) return;
  await gql(
    `mutation($input:IssueRelationCreateInput!){issueRelationCreate(input:$input){issueRelation{id}}}`,
    { input: { issueId: a.id, relatedIssueId: b.id, type: "blocks" } },
  );
}

// ---------------------------------------------------------------- rendering

const when = (iso) => iso.replace("T", " ").slice(0, 16);

/** An issue as Markdown an agent can read in one go. */
export function render(i) {
  const out = [
    `# ${i.identifier}: ${i.title}`,
    "",
    `- URL: ${i.url}`,
    `- State: ${i.state.name}`,
    `- Labels: ${i.labels.join(", ") || "none"}`,
    `- Milestone: ${i.projectMilestone?.name ?? "none"}`,
  ];
  if (i.blockedBy.length)
    out.push(
      `- Blocked by: ${i.blockedBy.map((b) => `${b.identifier} (${b.state.type === "completed" ? "done" : "open"})`).join(", ")}`,
    );
  if (i.blocks.length)
    out.push(`- Blocks: ${i.blocks.map((b) => b.identifier).join(", ")}`);
  const links = i.attachments.filter((a) => /github\.com\/.+\/pull\//.test(a.url));
  if (links.length) out.push(`- Pull requests: ${links.map((a) => a.url).join(", ")}`);
  out.push("", "## Spec", "", i.description?.trim() || "_(no description)_", "");
  if (i.comments.length) {
    out.push(`## Comments (${i.comments.length})`, "");
    const byDate = [...i.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const roots = byDate.filter((c) => !c.parent);
    for (const c of roots) {
      out.push(
        `### ${c.user?.name ?? "someone"}, ${when(c.createdAt)} (comment ${c.id})`,
        "",
        c.body.trim(),
        "",
      );
      for (const r of byDate.filter((x) => x.parent?.id === c.id))
        out.push(
          `> **Reply from ${r.user?.name ?? "someone"}, ${when(r.createdAt)} (comment ${r.id}):**`,
          ...r.body
            .trim()
            .split("\n")
            .map((l) => `> ${l}`),
          "",
        );
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[k + 1];
      if (next === undefined || next.startsWith("--")) opts[name] = true;
      else {
        if (name === "label") {
          opts.label ??= [];
          opts.label.push(next);
        } else opts[name] = next;
        k++;
      }
    } else positional.push(a);
  }
  return { positional, opts };
}

const bodyFrom = (opts) => {
  if (opts["body-file"])
    return readFileSync(opts["body-file"] === "-" ? 0 : opts["body-file"], "utf8");
  if (typeof opts.body === "string") return opts.body;
  throw new Error("Pass --body <text> or --body-file <path | ->");
};

async function cli(argv) {
  const { positional, opts } = parseArgs(argv);
  const [cmd, a, b] = positional;
  const json = (v) => console.log(JSON.stringify(v, null, 2));
  switch (cmd) {
    case "me":
      return json(await viewer());
    case "issue": {
      const i = await issue(a, { comments: true, history: Boolean(opts.history) });
      if (!i) throw new Error(`No issue ${a}`);
      return opts.json ? json(i) : console.log(render(i));
    }
    case "list": {
      const items = await list({
        state: opts.state ? String(opts.state).split(",") : undefined,
        labels: opts.label ?? [],
        noMilestone: Boolean(opts["no-milestone"]),
        open: !opts.all,
      });
      const brief = items.map((i) => ({
        identifier: i.identifier,
        title: i.title,
        state: i.state.name,
        labels: i.labels,
        milestone: i.projectMilestone?.name ?? null,
        url: i.url,
      }));
      return opts.json
        ? json(brief)
        : console.log(
            brief.map((i) => `${i.identifier}\t${i.state}\t${i.title}`).join("\n"),
          );
    }
    case "search":
      return json(
        (await search(positional.slice(1).join(" "))).map((i) => ({
          identifier: i.identifier,
          title: i.title,
          url: i.url,
        })),
      );
    case "comment": {
      const c = await comment(a, bodyFrom(opts), { replyTo: opts["reply-to"] });
      return json(c);
    }
    case "edit-comment":
      return json(await editComment(a, bodyFrom(opts)));
    case "state":
      return json(await setState(a, b));
    case "label":
      return json(await addLabel(a, b));
    case "unlabel":
      return json(await removeLabel(a, b));
    case "milestone":
      return json(await setMilestone(a, b));
    case "milestones":
      return json((await milestones()).map((m) => m.name));
    case "states":
      return json((await states()).map((s) => `${s.name} (${s.type})`));
    case "create": {
      if (!opts.title) throw new Error("Pass --title");
      const body = opts.body !== undefined || opts["body-file"] ? bodyFrom(opts) : "";
      return json(
        await create({
          title: opts.title,
          body,
          state: opts.state ?? "Backlog",
          labels: opts.label ?? [],
          milestone: opts.milestone,
        }),
      );
    }
    case "blocks":
      await relateBlocks(a, b);
      return console.log(`${a} blocks ${b}`);
    default:
      console.error(
        "usage: linear.mjs me | issue <id> [--json] [--history] | list [--state A,B] [--label x] [--no-milestone] [--all] [--json] | search <words> | comment <id> --body|--body-file [--reply-to <comment>] | edit-comment <comment> --body|--body-file | state <id> <name> | label <id> <name> | unlabel <id> <name> | milestone <id> <name> | milestones | states | create --title t [--body-file f] [--label l]... [--state s] [--milestone m] | blocks <blocker> <blocked>",
      );
      process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
