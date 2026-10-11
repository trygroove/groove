<!--
  Title: "Implement GRV-<n>: Title" for a feature or polish, "Fix GRV-<n>: Title"
  for a fix (the Linear card). Open it ready for review, not as a draft.
  See CLAUDE.md, "Landing work".
-->

## What & why

<!-- What this PR changes and why. In a sequence of PRs for one issue, say "i of N, follows #<prev>". -->

Completes GRV-<!-- the card's number; Refs on an earlier PR of a sequence, Closes only on a PR QA'd on a preview -->

## Screenshots

<!--
  Required whenever any UI changed (markup, CSS, copy): the changed state, and
  the before state when the contrast is the point. One to five images, not every
  step. Capture with `bun run screenshots -- <spec>` (or walkthrough:capture)
  and paste what `bun run walkthrough:publish -- --issue GRV-<n>` prints.
  If nothing a user sees changed, write "No UI change".
-->

## Evidence

<!--
  The commands you ran and their real results. For a fix, the regression
  test's failure output from before the fix.
-->

## Cloud APIs

<!--
  Any Google Cloud API this PR needs that production does not use yet, such as
  Cloud Scheduler for an `onSchedule` function. The deploy cannot enable one, so
  the product owner runs the command before approving. For each API: its
  name, why it is required (the code that needs it and what that code does),
  and the command. For example:
    cloudscheduler.googleapis.com: `purgeExpiredTranscripts` is an `onSchedule`
    function that deletes expired transcripts every hour, and Firebase deploys
    a scheduled function as a Cloud Scheduler job.
    gcloud services enable cloudscheduler.googleapis.com --project <project-id>
  Delete this section if the PR needs no new API. See CLAUDE.md, "Landing work".
-->

## Notes

<!--
  Assumptions made without asking, deviations from the issue, core flows added
  or changed (and why), contract changes. Delete if there are none.
-->
