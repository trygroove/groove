#!/usr/bin/env bash
# Act on a red CI run, so nobody has to notice it first.
#
# Called by .github/workflows/ci-failure.yml:
#
#   queue <run-id> <queue-branch>  A merge-queue run failed. GitHub has already
#                                  taken the PR out of the queue; hand it back to
#                                  @claude to fix, and move its card (Linear) back
#                                  to In Progress. A push re-queues it (merge.yml).
#   main <run-id> <sha> <attempt>  CI failed on main after <sha> landed. Stop the
#                                  line (merge.mjs stop) and re-run the failed jobs
#                                  once: a flake goes green and the line resumes. If
#                                  they fail again, and <sha> is the squash of a PR
#                                  and main was green before it, revert it through
#                                  the queue, hold the card's other open PRs, and
#                                  file a Linear issue to land it again. Otherwise
#                                  file a bug.
#   pr <run-id> <branch> <sha> <attempt>
#                                  A PR's own CI run (pull_request, outside the
#                                  queue) failed on the PR's head. Unless a Claude
#                                  run is already on it, re-run the failed jobs
#                                  once; if they fail again, hand the PR to
#                                  @claude with the run link. If the run that
#                                  fails is the fix's (this handler handed the PR
#                                  over in the last day and it has been pushed
#                                  since), move its card to Blocked instead
#                                  (GRV-197). Each run is acted on once, so the
#                                  board's poll can call this as a backstop for a
#                                  re-run whose completion never reached the
#                                  workflow (board.mjs, pollRetriedRuns). When
#                                  it hands the PR over or blocks the card, it
#                                  prints `ci-failure:acted <pr>` on stdout,
#                                  which tells that poll not to sweep the card.
#
# Needs LINEAR_API_KEY, and `linear.mjs` and `merge.mjs` beside this script.
#
# Only the gate jobs count on main: a failed deploy is infrastructure (a missing
# role or API), and reverting code would not fix it.
set -euo pipefail

mode="$1"
run="$2"
ref="$3"
repo="${GITHUB_REPOSITORY:?}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/$run"
# Keep in step with GATE_JOBS in merge.mjs.
gates='^(typecheck, check, unit \+ component tests|browser sanity \(chromium\)|firebase emulator tests|production build \+ no-secrets-in-bundle check)$'
footer=$'\n---\n_Posted by the CI-failure workflow (`.github/workflows/ci-failure.yml`)._'

log() { echo "ci-failure: $*" >&2; }
linear() { node "$(dirname "${BASH_SOURCE[0]}")/linear.mjs" "$@"; }
merge() { node "$(dirname "${BASH_SOURCE[0]}")/merge.mjs" "$@"; }
team="${LINEAR_TEAM:-GRV}"

# The Linear card a PR body closes, completes or refers to (`GRV-12`), if any.
issue_of() {
	gh api "repos/$repo/pulls/$1" --jq .body |
		grep -oiE "\b(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|completes?) $team-[0-9]+" |
		grep -oiE "$team-[0-9]+" | head -1 | tr '[:lower:]' '[:upper:]' || true
}

# File a Linear issue: $1 title, $2 label, body on stdin. Prints its identifier.
file_linear() {
	linear create --title "$1" --label "$2" --body-file - | jq -r .identifier
}

# Re-run a run's failed jobs. As RERUN_TOKEN (the job's GITHUB_TOKEN, with
# `actions: write`): GH_TOKEN is the PAT, which has no Actions permission.
# Fails, rather than exiting the script, when GitHub refuses.
rerun() {
	GH_TOKEN="${RERUN_TOKEN:-${GH_TOKEN:-}}" gh run rerun "$1" --repo "$repo" --failed
}

failed_gates() {
	gh api --paginate "repos/$repo/actions/runs/$1/jobs" \
		--jq '.jobs[] | select(.conclusion == "failure") | .name' | grep -E "$gates" || true
}

# File a bug for a red main that is not reverted automatically. $1 says why not.
file_bug() {
	log "not reverting ($1); filing a bug"
	file_linear "Bug: CI is red on main" bug <<EOF
CI failed on \`main\` after "$subject" landed, and it was not reverted automatically: $1. $run_url

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

Find the cause in that run, fix \`main\`, and say here which change broke it. The line is stopped until \`main\` is green: label the fix's PR \`fixes-main\` so it can land.
$footer
EOF
}

case "$mode" in
queue)
	# gh-readonly-queue/main/pr-123-<sha>: the last PR in the tested group.
	pr="$(sed -nE 's#^gh-readonly-queue/[^/]+/pr-([0-9]+)-.*#\1#p' <<<"$ref")"
	[ -n "$pr" ] || { log "no PR in $ref"; exit 0; }
	[ "$(gh api "repos/$repo/pulls/$pr" --jq .state)" = open ] || { log "#$pr is not open"; exit 0; }
	# With main red, the failure is main's, not this PR's: it rejoins the queue
	# on its own once main is green (merge.mjs resume).
	if [ "$(merge status)" = stopped ]; then
		log "the line is stopped; #$pr waits for main"
		exit 0
	fi
	gh pr comment "$pr" --repo "$repo" --body-file - <<EOF
@claude The merge queue tested this PR on top of \`main\` (and any PRs queued ahead of it) and CI failed, so it was taken out of the queue: $run_url

Find the cause in that run's failing job. Bring this branch up to date with \`main\` (\`git merge origin/main\`; never a rebase or force-push), reproduce the failure, fix it, run the checks it touches, and push. The push puts the PR back in the queue. If the failure comes from a PR queued ahead of this one rather than from this change, say so here instead of changing anything.
$footer
EOF
	issue="$(issue_of "$pr")"
	if [ -n "$issue" ]; then
		linear state "$issue" "In Progress" >/dev/null || log "could not move $issue to In Progress"
	fi
	log "#$pr handed back to @claude"
	;;
main)
	sha="$ref"
	attempt="${4:-1}"
	failed="$(failed_gates "$run")"
	[ -n "$failed" ] || { log "only non-gate jobs failed; nothing to revert"; exit 0; }

	# Stop the line: nothing else lands, and no new build starts, until main is green.
	merge stop "$run_url"

	# A flake is not a reason to revert. Re-run the failed jobs once; green resumes
	# the line, and a second failure comes back here as attempt 2. When GitHub
	# refuses the re-run, decide now rather than leave the line stopped.
	if [ "$attempt" = 1 ]; then
		if rerun "$run"; then
			log "re-running the failed jobs of $run before deciding"
			exit 0
		fi
		log "could not re-run $run; deciding now"
	fi

	git fetch --quiet origin main
	subject="$(git log -1 --format=%s "$sha")"
	parent="$(git rev-parse "$sha^")"
	pr="$(sed -nE 's/.*\(#([0-9]+)\)$/\1/p' <<<"$subject")"

	# Revert only when the commit is clearly the cause: main was green before it.
	parent_run="$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$parent&event=push" \
		--jq '[.workflow_runs[] | select(.head_branch == "main")][0] | "\(.id) \(.status)"')"
	parent_green=false
	if [ "${parent_run#* }" = completed ] && [ -z "$(failed_gates "${parent_run%% *}")" ]; then
		parent_green=true
	fi

	if [ -z "$pr" ] || [ "$parent_green" != true ] || [[ "$subject" == Revert* ]]; then
		file_bug "it is not a PR squash, \`main\` was not green before it, or it is itself a revert"
		exit 0
	fi

	branch="revert/pr-$pr"
	git checkout --quiet -B "$branch" origin/main
	if ! git revert --no-edit --no-commit "$sha" >/dev/null 2>&1; then
		git revert --abort
		file_bug "reverting #$pr conflicts with what landed after it"
		exit 0
	fi
	git commit --quiet -m "Revert \"$subject\"" -m "CI failed on main after it landed: $run_url"
	git push --quiet --force origin "$branch"

	title="$(gh api "repos/$repo/pulls/$pr" --jq .title)"
	issue="$(issue_of "$pr")"
	reland="$(file_linear "Re-land #$pr: $title" bug <<EOF
https://github.com/$repo/pull/$pr turned CI red on \`main\` and was reverted automatically: $run_url

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

Land the change again with the failure fixed: bring back that PR's diff on a branch from \`main\`, reproduce the failure, fix it, and open one PR.${issue:+ The original card is $issue.}
$footer
EOF
)"
	revert="$(gh pr create --repo "$repo" --base main --head "$branch" \
		--title "Revert #$pr: $title" --body-file - <<EOF
Reverts #$pr automatically: CI failed on \`main\` after it landed, and \`main\` was green before it. $run_url

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

Landing it again is tracked in Linear as $reland. This PR is labelled \`status:approved\`, so it merges through the queue once its checks pass.
$footer
EOF
)"
	gh pr edit "$revert" --repo "$repo" --add-label status:approved >/dev/null
	# The card's later PRs were built on this one: hold them until it lands again.
	if [ -n "$issue" ]; then
		merge hold "$pr" "$issue" || log "could not hold the other PRs for $issue"
	fi
	gh pr comment "$pr" --repo "$repo" --body "CI failed on \`main\` after this landed ($run_url), so it is being reverted in $revert. Re-landing is tracked in Linear as $reland.$footer" >/dev/null
	log "reverting #$pr in $revert; re-land in $reland"
	;;
pr)
	branch="$ref"
	sha="${4:?}"
	attempt="${5:-1}"
	# Hidden in the rendered comment: how a later run knows this handler handed
	# the PR to @claude, and so that a red run after that is the fix's.
	marker='<!-- ci-failure:pr -->'
	# And which run a comment was about: this handler acts on each run once.
	done_marker="<!-- ci-failure:run:$run -->"
	pr="$(gh api "repos/$repo/pulls?state=open&head=${repo%%/*}:$branch" --jq '.[0].number // empty')"
	[ -n "$pr" ] || { log "no open PR from $branch"; exit 0; }
	[ "$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)" = "$sha" ] || {
		log "#$pr has been pushed since $sha; the newer run decides"
		exit 0
	}
	if gh api --paginate "repos/$repo/issues/$pr/comments?per_page=100" --jq '.[].body' | grep -qF "$done_marker"; then
		log "#$pr: run $run has been handled already"
		exit 0
	fi
	failed="$(failed_gates "$run")"
	[ -n "$failed" ] || { log "#$pr: only non-gate jobs failed"; exit 0; }
	# With main red, a PR run (which tests the merge with main) fails for main's
	# reason: main is being dealt with, and this PR waits for it.
	if [ "$(merge status)" = stopped ]; then
		log "the line is stopped; #$pr waits for main"
		exit 0
	fi
	pushed="$(gh api "repos/$repo/commits/$sha" --jq .commit.committer.date)"
	# "<created_at> mine|other" for every @claude comment on the PR.
	mentions="$(gh api --paginate "repos/$repo/issues/$pr/comments?per_page=100" \
		--jq ".[] | select(.body | contains(\"@claude\")) | \"\(.created_at) \(if (.body | contains(\"$marker\")) then \"mine\" else \"other\" end)\"")"
	# An @claude comment since this commit: a Claude run is on it already (or
	# this handler handed it over for an earlier failure of the same commit).
	if awk -v t="$pushed" '$1 > t { found = 1 } END { exit !found }' <<<"$mentions"; then
		log "#$pr: an @claude run already has it"
		exit 0
	fi
	# Re-run once. When GitHub refuses, hand it over now rather than not at all.
	retried=" and again on a re-run"
	if [ "$attempt" = 1 ]; then
		if rerun "$run"; then
			log "#$pr: re-running the failed jobs of $run before handing it over"
			exit 0
		fi
		log "#$pr: could not re-run $run; handing it over without a re-run"
		retried=" (it could not be re-run)"
	fi
	day_ago="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
	issue="$(issue_of "$pr")"
	if awk -v t="$day_ago" '$2 == "mine" && $1 > t { found = 1 } END { exit !found }' <<<"$mentions"; then
		# This handler handed the PR to @claude in the last day, it has been
		# pushed since, and the fix is red too: someone has to look.
		gh pr comment "$pr" --repo "$repo" --body-file - <<EOF
CI failed again on this PR after the fix for its last failure$retried: $run_url
$done_marker

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

${issue:+Its card $issue is moved to Blocked: }this needs a person to look before another fix is tried.
$footer
EOF
		if [ -n "$issue" ]; then
			linear state "$issue" Blocked >/dev/null || log "could not move $issue to Blocked"
			linear comment "$issue" --body-file - >/dev/null <<EOF || log "could not comment on $issue"
**Moved to Blocked: CI is still red on https://github.com/$repo/pull/$pr after a fix.** The PR's own CI run failed and was handed to a Claude run, and the fix's run failed as well: $run_url

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

**Unblocked by:** someone finding the cause (a flaky test, or a problem outside this PR, can look like this). Mention Claude in a comment on the PR saying what to do, or push a fix yourself; then move this card back to In Progress.
EOF
		fi
		echo "ci-failure:acted $pr"
		log "#$pr: red again after the fix; ${issue:-no card} to Blocked"
		exit 0
	fi
	gh pr comment "$pr" --repo "$repo" --body-file - <<EOF
@claude CI failed on this PR's head$retried, so it cannot merge: $run_url
$marker
$done_marker

Failing jobs:
$(sed 's/^/- /' <<<"$failed")

Find the cause in that run's failing job. Bring this branch up to date with \`main\` (\`git merge origin/main\`; never a rebase or force-push), reproduce the failure, fix it, run the checks it touches, and push. If the cause is a flaky test rather than this change, fix the flake rather than retrying.
$footer
EOF
	echo "ci-failure:acted $pr"
	log "#$pr handed to @claude"
	;;
*)
	echo "usage: ci-failure.sh queue <run-id> <queue-branch> | main <run-id> <sha> <attempt> | pr <run-id> <branch> <sha> <attempt>" >&2
	exit 2
	;;
esac
