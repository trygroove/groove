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
 * Each toast is an `<output>`, whose implicit role is `status`, so a screen
 * reader announces it. Nothing is on the page while no toast is showing, so
 * an editor with no notice has no empty status region in it.
 */
export function Toast(props: ToastProps) {
  return (
    <For each={props.toast ? [props.toast] : []}>
      {(toast) => (
        <ToastBody
          message={toast.message}
          durationMs={props.durationMs ?? TOAST_DURATION_MS}
          onClose={() => props.onClose()}
        />
      )}
    </For>
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
    <output class="toast" aria-live="polite">
      <span class="toast-message">{props.message}</span>
      <button
        type="button"
        class="toast-close"
        aria-label="Dismiss"
        onClick={() => props.onClose()}
      >
        ×
      </button>
    </output>
  );
}
