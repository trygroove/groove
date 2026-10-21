// Reports a failed save to error monitoring (GRV-55, PRD `OPS-03`).
//
// `ProjectAutosave` already logs `save_failed` to analytics for every failed
// attempt, with how many attempts it has cost. Monitoring wants one event per
// *failure*: from the first write that is refused until a write lands again.
// A save that keeps failing while the producer is offline is one failure, not
// one event per retry, and the analytics stream says how many retries it took.
//
// The event carries the failure's stable code and whether the browser was
// online, never the repository's message (it can carry backend text), the
// project's name or anything in it.

import { toErrorCode } from "../../analytics/errorCodes";
import { browserOnline } from "../../monitoring/errorContext";
import { CodedError, reportError } from "../../monitoring/errorReporting";
import type { ProjectAutosave } from "../../persistence/autosave";

export interface SaveFailureReportOptions {
  /** The reporting boundary; tests inject a recorder. */
  readonly report?: typeof reportError;
  /** Whether the browser is online; tests inject one. */
  readonly online?: () => boolean | undefined;
}

/** Reports `autosave`'s failures, one per failure episode. Returns the way to stop. */
export function reportSaveFailures(
  autosave: Pick<ProjectAutosave, "subscribe">,
  options: SaveFailureReportOptions = {},
): () => void {
  const report = options.report ?? reportError;
  const online = options.online ?? browserOnline;
  let reported = false;
  return autosave.subscribe((status) => {
    if (status.state === "saved") {
      reported = false;
      return;
    }
    if (status.state !== "failed" || !status.failure || reported) return;
    reported = true;
    const code = toErrorCode(status.failure.reason);
    report(new CodedError(code, "The autosave write was refused"), {
      area: "persistence",
      fatal: false,
      code,
      context: { online: online() },
    });
  });
}
