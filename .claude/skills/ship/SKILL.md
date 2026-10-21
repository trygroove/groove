---
name: ship
description: Ship one Groove Linear issue unattended, whether it is a feature, a fix or polish. Triages the kind of work, builds it, reviews features, and opens ready-for-review PRs with screenshots and a preview deploy. Use when asked to ship, build, implement or fix an issue, e.g. "/ship GRV-123", "ship GRV-123", "fix GRV-123", "implement GRV-123".
---

# Ship an issue

The issue's spec was agreed in an interactive shape session, so this runs
without asking questions. See `CLAUDE.md`, "Shape, then ship".

1. **Resolve the issue identifier** from the argument (`GRV-123`, `grv-123`,
   a bare `123` meaning `GRV-123`, or a Linear issue URL). If none was given,
   ask for one. `LINEAR_API_KEY` must be set: the stages read and comment on
   the card with `node .github/scripts/linear.mjs`.
2. **Run the workflow**: call the Workflow tool with
   `{ name: "solid-groove-ship", args: { issue: "GRV-123" } }`. Do not build anything
   yourself; the workflow does triage, build, review (features only) and landing.
   Landing opens the PRs one at a time, each against `main` once the one before
   it has merged, so a run with several PRs takes as long as those merges.
   If the session cannot run workflows, or is headless (GitHub Actions, `-p`),
   run the same stages yourself with the Agent tool in the foreground
   (`run_in_background: false`), following `.claude/workflows/solid-groove-ship.js`
   and the agent briefs in `.claude/agents/`, with the `model` and `effort` each
   stage names there (triage and the landing agents run on Sonnet; the build,
   its fixes and the review run on the tier triage picks: Haiku, Sonnet or Opus,
   from the issue's complexity and novelty, or a `model:<tier>` label on the card). A headless run ends when your turn
   ends, so a background workflow there is killed before it does anything.
   Never end your turn while the work is still running.
3. **When it returns**, confirm every PR it names exists (`gh pr view <n>` or the
   GitHub MCP tools) before reporting it. Report only what you have seen, never
   an expected or summarised result. Then tell the user in a few lines:
   - the PRs it opened (full URLs), the kind of work it treated the issue as,
     and the model tier it built on;
   - any assumptions or open review findings that ended up in a PR body;
   - or, if it stopped, why (an issue likely to conflict with an open PR is held
     off: the PRs it waits for are named on the card, their cards become its
     blockers and it goes back to Ready, where the board starts it again once
     they merge; an unclear issue posts
     its question on the card and moves it to Blocked; answer there or in this
     session and re-run `/ship`; a run that stopped part way through a sequence,
     at a gated PR or one that did not merge in time, leaves a "Handoff from
     /ship" comment and moves the card to Blocked; once the PR it waits on
     merges, the board moves the card back to Ready by itself and `/ship`
     continues from what has landed).
4. **Watch the PRs** if `subscribe_pr_activity` is available: subscribe to each
   one and drive it to green (CI fixes, QA findings, merge conflicts) as the
   events arrive.

Edit the workflow or the agent briefs freely when they get something wrong; they
are this repo's process, not fixed rules.
