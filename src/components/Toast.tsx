// A small notice in the bottom-left corner that closes itself (GRV-88): the
// app's one shared toast, so later notices reuse it rather than adding their own.

import { For } from "@solidjs/web";
import { onSettled } from "solid-js";
import "./Toast.css";

/** How long a toast stays up before it closes itself. */
export const TOAST_DURATION_MS = 6_000;

/**
 * One notice. A new object is a new toast: it replaces the one showing and
 * restarts the timer, even when the words are the same.
 */
export interface ToastMessage {
  readonly message: string;
}

export interface ToastProps {
  /** The toast showing, or null for none. One at a time. */
  readonly toast: ToastMessage | null;
  /** Called when it closes itself or is closed. */
  readonly onClose: () => void;
  readonly durationMs?: number;
}

/**
 * The toasts go in one `<output>`, whose implicit role is `status`, that is
 * always on the page and empty while no toast shows. A live region present
 * before its content changes is announced more reliably than one mounted
 * with its message already in it.
 */
export function Toast(props: ToastProps) {
  return (
    <output class="toast-region" aria-live="polite">
      <For each={props.toast ? [props.toast] : []}>
        {(toast) => (
          <ToastBody
            message={toast.message}
            durationMs={props.durationMs ?? TOAST_DURATION_MS}
            onClose={() => props.onClose()}
          />
        )}
      </For>
    </output>
  );
}

function ToastBody(props: {
  readonly message: string;
  readonly durationMs: number;
  readonly onClose: () => void;
}) {
  onSettled(() => {
    const timer = setTimeout(() => props.onClose(), props.durationMs);
    return () => clearTimeout(timer);
  });
  return (
    <div class="toast">
      <span class="toast-message">{props.message}</span>
      <button
        type="button"
        class="toast-close"
        aria-label="Dismiss"
        onClick={() => props.onClose()}
      >
        ×
      </button>
    </div>
  );
}
