import type { Project } from "../../domain/entities";
import { CodedError, reportError } from "../../monitoring";
import type { PersistenceIssue } from "../../persistence/documents";
import type { LoadResult } from "../../persistence/projectRepository";

/** At most this many distinct issue kinds go into one report's message. */
const MAX_ISSUE_GROUPS = 5;

/**
 * Reports what went wrong opening a project, so a project nobody can open
 * can be diagnosed rather than only showing the user a generic error (#965).
 *
 * Two outcomes are reported, both non-fatal (the editor shows its own state
 * for each and nothing crashed):
 *
 * - A load that failed for any reason but `not_found`, coded by the
 *   repository's reason and carrying a summary of the decode issues.
 * - A load that succeeded only after dropping references to documents that
 *   were never stored, so a store still being left in that state shows up.
 *
 * The message never carries an issue's own text, which names entity IDs and
 * can quote stored values: only issue codes and the *shape* of where they
 * were found, with indices and IDs reduced to placeholders, plus counts.
 */
export function reportProjectLoad(
  result: LoadResult<Project>,
  report: typeof reportError = reportError,
): void {
  if (!result.ok) {
    if (result.reason === "not_found") return;
    report(
      new CodedError(
        result.reason,
        `Project load failed: ${summarizeLoadIssues(result.issues ?? [])}`,
      ),
      { area: "persistence", fatal: false },
    );
    return;
  }
  if (result.dropped) {
    report(
      new CodedError(
        "invalid_document",
        `Project opened after dropping ${result.dropped.placements} placement(s) with no stored clip and ${result.dropped.clipIds.length} clip(s) with no stored track`,
      ),
      { area: "persistence", fatal: false },
    );
  }
}

/**
 * `dangling_reference x11 at song.placements.#.clipId; ...` — the issues
 * grouped by code and path shape, most frequent first.
 */
export function summarizeLoadIssues(issues: readonly PersistenceIssue[]): string {
  if (issues.length === 0) return "no issues reported";
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const key = `${issue.code} at ${pathShape(issue.path)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = groups
    .slice(0, MAX_ISSUE_GROUPS)
    .map(([key, count]) => key.replace(" at ", ` x${count} at `));
  const hidden = groups.length - shown.length;
  return hidden > 0 ? `${shown.join("; ")}; and ${hidden} more` : shown.join("; ");
}

/**
 * A path with every index as `#` and every segment that is not a plain
 * property name (an entity ID, say) as `*`.
 */
function pathShape(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "(root)";
  return path
    .map((segment) =>
      typeof segment === "number" ? "#" : /^[A-Za-z]+$/.test(segment) ? segment : "*",
    )
    .join(".");
}
