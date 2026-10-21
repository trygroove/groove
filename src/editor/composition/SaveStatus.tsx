import { type Accessor, createMemo, Show } from "solid-js";
import type { SaveStatus as SaveStatusValue } from "../../persistence/autosave";
import type { SaveFailure, SaveFailureReason } from "../../persistence/projectRepository";

const SAVE_STATUS_LABEL: Record<string, string> = {
  idle: "",
  pending: "Saving…",
  saving: "Saving…",
  saved: "Saved",
  failed: "Save failed",
};

/**
 * Actionable text for the PRD `PRJ-03` "actionable Save failed" state. Never
 * the repository's raw `SaveFailure.message` — that can carry backend error
 * text not meant for a user-facing surface — and never the reason string
 * itself, which is an internal, unlocalized identifier.
 */
const SAVE_FAILURE_REASON_LABEL: Record<SaveFailureReason, string> = {
  unavailable: "Check your connection.",
  revision_conflict: "This project changed in another tab or session.",
  not_found: "This project no longer exists.",
  already_exists: "A save conflict occurred.",
  unsupported_schema_version: "This project needs a newer version of Groove.",
  invalid_document: "Something about this save wasn't valid.",
  document_too_large: "This project is too large to save further changes.",
};

/**
 * What an unsaved edit says while the browser is offline (GRV-55). The edit
 * is kept, queued, and written as soon as the connection is back, so the
 * message says that rather than only that the save failed.
 */
export const OFFLINE_LABEL = "Offline";
export const OFFLINE_MESSAGE = "Offline. Reconnect to save.";
export const OFFLINE_DETAIL =
  "You're offline. Your changes are kept here and save when you reconnect.";

/** A write that failed for want of a connection, which a later write can clear. */
function isConnectionFailure(failure: SaveFailure | null | undefined): boolean {
  return failure?.reason === "unavailable" && failure.retryable;
}

export interface SaveStatusProps {
  readonly saveStatus: Accessor<SaveStatusValue | null>;
  readonly onRetry: () => void;
  /** Whether the browser is online (`useOnline`); online when not given. */
  readonly online?: Accessor<boolean>;
}

/**
 * The header's save-status readout plus the PRD `PRJ-03` actionable
 * Save-failed alert (retry when retryable, a plain reason otherwise). Split
 * out of `EditorHeader` because it is fully self-contained: everything it
 * needs comes from `saveStatus`.
 */
export default function SaveStatus(props: SaveStatusProps) {
  const offline = () => props.online?.() === false;
  /**
   * The failure to show. A retry of a write the connection dropped clears the
   * autosave's failure while it is in flight, which can take half a minute
   * offline; the alert keeps saying why until a write lands (GRV-55).
   */
  const saveFailure = createMemo<SaveFailure | null>((previous) => {
    const status = props.saveStatus();
    if (!status || status.state === "saved" || status.state === "idle") return null;
    if (status.failure) return status.failure;
    return previous && isConnectionFailure(previous) ? previous : null;
  });
  /** Offline with an edit not yet written: waiting for the connection. */
  const waitingOffline = () => {
    const status = props.saveStatus();
    if ((status?.pending ?? 0) === 0 || status?.state === "failed") return false;
    // The browser's own word can be wrong (GRV-55), so a write that already
    // failed for want of a connection says so too until the next one starts.
    return (
      offline() || (status?.state === "pending" && isConnectionFailure(saveFailure()))
    );
  };
  const saveStatusLabel = () =>
    waitingOffline()
      ? OFFLINE_LABEL
      : SAVE_STATUS_LABEL[props.saveStatus()?.state ?? "idle"];
  /**
   * A failure for want of a connection: one a retry can clear, or any
   * unreachable backend while the browser says it is offline. Not decided by
   * `navigator.onLine` alone, which can say online while nothing gets through.
   */
  const offlineFailure = () => {
    const failure = saveFailure();
    return (
      isConnectionFailure(failure) || (offline() && failure?.reason === "unavailable")
    );
  };
  const saveFailureMessage = () => {
    const failure = saveFailure();
    if (!failure) return null;
    return offlineFailure() ? OFFLINE_MESSAGE : SAVE_FAILURE_REASON_LABEL[failure.reason];
  };
  const saveFailureDetail = () =>
    offlineFailure() ? OFFLINE_DETAIL : (saveFailureMessage() ?? undefined);

  return (
    <div class="save-status-group">
      <div
        class="save-status"
        data-state={props.saveStatus()?.state}
        data-offline={offline() ? "true" : undefined}
        data-revision={props.saveStatus()?.revision}
        title={
          waitingOffline()
            ? OFFLINE_DETAIL
            : `Revision ${props.saveStatus()?.revision ?? 0}`
        }
      >
        {saveStatusLabel()}
      </div>
      <Show when={saveFailure()}>
        {/* Titled with the reason, which narrow widths and long reasons
            hide or cut short (#1031). */}
        <div class="save-recovery" role="alert" title={saveFailureDetail()}>
          <span class="save-recovery-message">{saveFailureMessage()}</span>
          <Show when={saveFailure()?.retryable}>
            <button
              type="button"
              class="save-retry-button"
              onClick={() => props.onRetry()}
            >
              Retry
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
