import { describe, expect, it } from "vitest";
import {
  activeRuns,
  handoffAwaiting,
  mentionRequest,
  PICKUP,
  prActivity,
  retriedRuns,
  sweepVerdict,
} from "../../.github/scripts/board.mjs";
import {
  blockerCleared,
  openBlockers,
  startOrder,
} from "../../.github/scripts/linear.mjs";

const blocker = (identifier, name, type) => ({ identifier, state: { name, type } });

describe("blockerCleared", () => {
  it("clears once the blocker's work has merged or it is closed", () => {
    expect(blockerCleared(blocker("GRV-1", "QA", "started"))).toBe(true);
    expect(blockerCleared(blocker("GRV-1", "Done", "completed"))).toBe(true);
    expect(blockerCleared(blocker("GRV-1", "Canceled", "canceled"))).toBe(true);
    expect(blockerCleared(blocker("GRV-1", "Duplicate", "duplicate"))).toBe(true);
  });

  it("holds while the blocker is unbuilt or its PRs are still open", () => {
    for (const [name, type] of [
      ["Backlog", "backlog"],
      ["Ready", "unstarted"],
      ["In Progress", "started"],
      ["Blocked", "started"],
      ["Ready For Review", "started"],
      ["Approved", "started"],
    ])
      expect(blockerCleared(blocker("GRV-1", name, type))).toBe(false);
  });
});

describe("openBlockers", () => {
  it("lists only the blockers still holding the card back", () => {
    const card = {
      blockedBy: [
        blocker("GRV-1", "QA", "started"),
        blocker("GRV-2", "In Progress", "started"),
      ],
    };
    expect(openBlockers(card).map((b) => b.identifier)).toEqual(["GRV-2"]);
  });
});

describe("startOrder", () => {
  it("starts Urgent first and no-priority last, then follows the column order", () => {
    const cards = [
      { identifier: "none", priority: 0, sortOrder: -10 },
      { identifier: "low", priority: 4, sortOrder: 1 },
      { identifier: "high-later", priority: 2, sortOrder: 5 },
      { identifier: "urgent", priority: 1, sortOrder: 9 },
      { identifier: "high-first", priority: 2, sortOrder: 2 },
    ];
    expect(startOrder(cards).map((c) => c.identifier)).toEqual([
      "urgent",
      "high-first",
      "high-later",
      "low",
      "none",
    ]);
  });
});

describe("the idle sweep (GRV-197)", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
  const card = (extra = {}) => ({
    identifier: "GRV-7",
    state: { name: "In Progress" },
    history: [
      {
        createdAt: hoursAgo(5),
        fromState: { name: "Ready" },
        toState: { name: "In Progress" },
      },
    ],
    comments: [
      {
        body: "**Picking this up.** (run)",
        createdAt: hoursAgo(5),
        updatedAt: hoursAgo(3),
      },
    ],
    ...extra,
  });
  const gate = (conclusion, status = "COMPLETED") => ({
    __typename: "CheckRun",
    name: "typecheck, check, unit + component tests",
    status,
    conclusion,
  });
  const pr = (extra = {}) => ({
    number: 41,
    title: "Fix GRV-7: Something",
    url: "https://github.com/trygroove/groove/pull/41",
    body: "Completes GRV-7",
    isDraft: false,
    labels: [],
    comments: [],
    autoMergeRequest: { enabledAt: hoursAgo(4) },
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [gate("FAILURE")],
    ...extra,
  });

  it("moves a stale card with a red PR and nothing running to Blocked, naming its PRs", () => {
    const verdict = sweepVerdict(card(), { now, prs: [pr()], runs: [] });
    expect(verdict.action).toBe("block");
    expect(verdict.comment).toContain("#41");
    expect(verdict.comment).toContain(
      "CI failed (typecheck, check, unit + component tests)",
    );
    expect(verdict.comment.startsWith(PICKUP)).toBe(false);
  });

  it("moves a stale card with no PR open to Blocked", () => {
    const verdict = sweepVerdict(card(), { now, prs: [], runs: [] });
    expect(verdict.action).toBe("block");
    expect(verdict.comment).toContain("No open PR refers to it");
  });

  it("leaves a card with an agent run on it", () => {
    const ship = { workflow: "board", title: "Board", url: "u", jobs: ["ship GRV-7"] };
    expect(sweepVerdict(card(), { now, prs: [], runs: [ship] }).action).toBe("leave");
    const claude = {
      workflow: "claude",
      title: "Fix GRV-7: Something",
      url: "u",
      jobs: [],
    };
    expect(sweepVerdict(card(), { now, prs: [pr()], runs: [claude] }).action).toBe(
      "leave",
    );
    // Another card's run is not this card's: GRV-70 is not GRV-7.
    const other = {
      workflow: "board",
      title: "Board",
      url: "u",
      jobs: ["rework GRV-70"],
    };
    expect(sweepVerdict(card(), { now, prs: [], runs: [other] }).action).toBe("block");
  });

  it("leaves a card whose assistant experiment is running", () => {
    const started = card({
      comments: [
        {
          body: "**Experiment started.** `compact-notes` is running against the live model",
          createdAt: hoursAgo(3),
          updatedAt: hoursAgo(3),
        },
      ],
    });
    const run = (title) => ({ workflow: "experiment", title, url: "u", jobs: [] });
    expect(
      sweepVerdict(started, {
        now,
        prs: [],
        runs: [run("Assistant experiment compact-notes")],
      }).action,
    ).toBe("leave");
    // A run from before runs carried the experiment's ID could be this card's.
    expect(
      sweepVerdict(started, { now, prs: [], runs: [run("Assistant experiments")] })
        .action,
    ).toBe("leave");
    expect(
      sweepVerdict(started, {
        now,
        prs: [],
        runs: [run("Assistant experiment other-one")],
      }).action,
    ).toBe("block");
  });

  it("leaves a card active within the hour", () => {
    const recent = card({
      comments: [{ body: "progress", createdAt: hoursAgo(5), updatedAt: hoursAgo(0.5) }],
    });
    expect(sweepVerdict(recent, { now, prs: [], runs: [] }).action).toBe("leave");
    const mentioned = pr({
      comments: [{ body: "@claude fix it", createdAt: hoursAgo(0.2) }],
    });
    expect(sweepVerdict(card(), { now, prs: [mentioned], runs: [] }).action).toBe(
      "leave",
    );
  });

  it("leaves a card whose PR is queued or auto-merging with CI running", () => {
    const queued = pr({
      statusCheckRollup: [gate("SUCCESS")],
      mergeStateStatus: "CLEAN",
    });
    expect(sweepVerdict(card(), { now, prs: [queued], runs: [] }).action).toBe("leave");
    const running = pr({ statusCheckRollup: [gate(null, "IN_PROGRESS")] });
    expect(sweepVerdict(card(), { now, prs: [running], runs: [] }).action).toBe("leave");
  });

  it("never asks for a Claude run in the comments it posts", () => {
    const blocked = sweepVerdict(card(), { now, prs: [pr()], runs: [] });
    expect(blocked.comment).not.toMatch(/@claude/i);
    expect(mentionRequest(blocked.comment)).toBe(false);
    const gated = pr({
      labels: [{ name: "needs-approval" }],
      autoMergeRequest: null,
      statusCheckRollup: [gate("SUCCESS")],
    });
    const review = sweepVerdict(card(), { now, prs: [gated], runs: [] });
    expect(review.comment).not.toMatch(/@claude/i);
    expect(mentionRequest(review.comment)).toBe(false);
  });

  it("moves a stale card whose PRs only wait for approval to Ready For Review", () => {
    const gated = (extra) =>
      pr({
        labels: [{ name: "needs-approval" }],
        autoMergeRequest: null,
        statusCheckRollup: [gate("SUCCESS")],
        ...extra,
      });
    const verdict = sweepVerdict(card(), {
      now,
      prs: [
        gated(),
        gated({ number: 42, statusCheckRollup: [gate(null, "IN_PROGRESS")] }),
      ],
      runs: [],
    });
    expect(verdict.action).toBe("review");
    expect(verdict.comment).toContain("#41");
    expect(verdict.comment).toContain("#42");
    // Approved already, red, held, or beside a PR that is not gated: someone has to look.
    for (const prs of [
      [gated({ labels: [{ name: "needs-approval" }, { name: "status:approved" }] })],
      [gated({ statusCheckRollup: [gate("FAILURE")] })],
      [gated({ labels: [{ name: "needs-approval" }, { name: "hold" }] })],
      [gated(), pr({ number: 43, autoMergeRequest: null })],
    ])
      expect(sweepVerdict(card(), { now, prs, runs: [] }).action).toBe("block");
  });

  it("does not count a PR that cannot move on its own", () => {
    const stuck = [
      pr({ autoMergeRequest: null, statusCheckRollup: [gate("SUCCESS")] }),
      pr({ isDraft: true, statusCheckRollup: [gate("SUCCESS")] }),
      pr({ labels: [{ name: "hold" }], statusCheckRollup: [gate("SUCCESS")] }),
      pr({ mergeStateStatus: "DIRTY", statusCheckRollup: [gate("SUCCESS")] }),
    ];
    for (const p of stuck)
      expect(sweepVerdict(card(), { now, prs: [p], runs: [] }).action).toBe("block");
  });
});

describe("prActivity", () => {
  it("reads only the required checks, and says where the PR stands", () => {
    const p = {
      isDraft: false,
      labels: [{ name: "needs-approval" }],
      autoMergeRequest: null,
      statusCheckRollup: [
        {
          name: "branch push / typecheck, check, unit + component tests",
          conclusion: "FAILURE",
          status: "COMPLETED",
        },
        { name: "browser sanity (chromium)", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    };
    expect(prActivity(p)).toEqual({
      inFlight: false,
      onlyAwaitingApproval: true,
      state: "waiting for approval (`needs-approval`), not queued",
    });
  });
});

describe("handoffAwaiting", () => {
  const handoff = (first, createdAt = "2026-10-20T10:00:00Z") => ({
    body: `${first}\n\nThis run opened …`,
    createdAt,
  });
  const blocked = (comments, history = []) => ({
    identifier: "GRV-9",
    state: { name: "Blocked" },
    comments,
    history,
  });

  it("names the PR a Blocked, Ready For Review or Approved card's handoff waits on", () => {
    const comments = [handoff("**Handoff from /ship.** Waiting on #812 to merge.")];
    expect(handoffAwaiting(blocked(comments))).toBe(812);
    expect(handoffAwaiting({ ...blocked(comments), state: { name: "Approved" } })).toBe(
      812,
    );
    // A gated PR moves its card to Ready For Review (merge.mjs).
    expect(
      handoffAwaiting({ ...blocked(comments), state: { name: "Ready For Review" } }),
    ).toBe(812);
  });

  it("names none when it waits on a decision, the card is elsewhere, or it already resumed", () => {
    expect(
      handoffAwaiting(
        blocked([
          handoff(
            "**Handoff from /ship.** Waiting on a decision: #812 was closed without merging.",
          ),
        ]),
      ),
    ).toBeNull();
    const comments = [handoff("**Handoff from /ship.** Waiting on #812 to merge.")];
    expect(
      handoffAwaiting({ ...blocked(comments), state: { name: "In Progress" } }),
    ).toBeNull();
    expect(
      handoffAwaiting(
        blocked(comments, [
          { createdAt: "2026-10-20T11:00:00Z", toState: { name: "Ready" } },
        ]),
      ),
    ).toBeNull();
    expect(handoffAwaiting(blocked([]))).toBeNull();
  });

  it("reads the latest handoff", () => {
    const comments = [
      handoff(
        "**Handoff from /ship.** Waiting on #812 to merge.",
        "2026-10-19T10:00:00Z",
      ),
      handoff(
        "**Handoff from /ship.** Waiting on #900 to merge.",
        "2026-10-20T10:00:00Z",
      ),
    ];
    expect(
      handoffAwaiting(
        blocked(comments, [
          { createdAt: "2026-10-19T12:00:00Z", toState: { name: "Ready" } },
        ]),
      ),
    ).toBe(900);
  });
});

describe("mentionRequest", () => {
  it("is a person's comment that says @claude", () => {
    expect(mentionRequest("@claude please look at the export")).toBe(true);
    expect(mentionRequest("Can @Claude check this?")).toBe(true);
    expect(mentionRequest("No mention here")).toBe(false);
  });

  it("is never a comment the automation wrote", () => {
    for (const body of [
      `${PICKUP}.** ([run](u)) after @claude`,
      "**Moved to Blocked: CI is still red on https://github.com/o/r/pull/1 after a fix.** handed to @claude",
      "**Moved to Ready For Review: its PRs wait for approval.** @claude",
      "**Back to Ready.** #812 merged; @claude",
    ])
      expect(mentionRequest(body)).toBe(false);
  });
});

describe("activeRuns", () => {
  it("asks for unfinished runs by status, so a ship job hours old still counts", () => {
    const calls = [];
    // GitHub's latest 100 board runs are all finished; the long ship run is
    // found only by asking for in-progress runs.
    const list = (path) => {
      calls.push(path);
      if (path.includes("/runs/7/jobs")) return ["poll", "ship GRV-7"];
      if (path.includes("board.yml/runs?status=in_progress"))
        return [{ id: 7, title: "Board", url: "u7" }];
      // The same run listed under two statuses is counted once.
      if (path.includes("board.yml/runs?status=queued"))
        return [{ id: 7, title: "Board", url: "u7" }];
      return [];
    };
    const runs = activeRuns(list);
    expect(runs).toEqual([
      {
        workflow: "board",
        id: 7,
        title: "Board",
        url: "u7",
        jobs: ["poll", "ship GRV-7"],
      },
    ]);
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"])
      for (const file of ["board.yml", "claude.yml", "assistant-experiments.yml"])
        expect(calls.some((c) => c.includes(`${file}/runs?status=${status}`))).toBe(true);
    expect(calls.every((c) => !c.endsWith("runs?per_page=100"))).toBe(true);
    const stale = {
      identifier: "GRV-7",
      state: { name: "In Progress" },
      history: [],
      comments: [],
    };
    expect(sweepVerdict(stale, { now: Date.now(), prs: [], runs }).action).toBe("leave");
  });
});

describe("retriedRuns", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();
  const prs = [{ number: 41, headRefName: "claude/grv-7-x", body: "Completes GRV-7" }];
  const run = (extra) => ({
    id: 1,
    branch: "claude/grv-7-x",
    sha: "abc",
    attempt: 2,
    updatedAt: minutesAgo(30),
    ...extra,
  });

  it("hands over an open PR's run that failed again on a re-run, after a grace period", () => {
    expect(retriedRuns([run()], prs, now).map((r) => r.id)).toEqual([1]);
  });

  it("leaves a first attempt, a fresh failure and a branch with no open PR", () => {
    expect(
      retriedRuns(
        [
          run({ attempt: 1 }),
          run({ updatedAt: minutesAgo(2) }),
          run({ branch: "claude/grv-8-y" }),
        ],
        prs,
        now,
      ),
    ).toEqual([]);
  });
});
