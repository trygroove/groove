// The editor's toast for session notices (GRV-88): an unsaved edit dropped,
// or an undo or redo refused, because the project changed in another tab.

import { createSignal, onCleanup } from "solid-js";
import { Toast, type ToastMessage } from "../../components/Toast";
import type { SessionNotice, SessionNoticeListener } from "./EditorSession";

/** The words a notice is shown with. */
export function noticeMessage(notice: SessionNotice): string {
  switch (notice.kind) {
    case "edits_discarded":
      return notice.count === 1
        ? "A change you made was discarded because the project changed in another tab."
        : `${notice.count} changes you made were discarded because the project changed in another tab.`;
    case "undo_refused":
      return notice.direction === "undo"
        ? "Can't undo: that changed in another tab."
        : "Can't redo: that changed in another tab.";
  }
}

export interface SessionToastProps {
  /** Subscribes to the open session's notices; returns the unsubscribe. */
  readonly onNotice: (listener: SessionNoticeListener) => () => void;
}

/** Shows the newest notice; a new one replaces the one showing. */
export function SessionToast(props: SessionToastProps) {
  const [toast, setToast] = createSignal<ToastMessage | null>(null);
  onCleanup(props.onNotice((notice) => setToast({ message: noticeMessage(notice) })));
  return <Toast toast={toast()} onClose={() => setToast(null)} />;
}
