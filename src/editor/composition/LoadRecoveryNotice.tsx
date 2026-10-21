import { createSignal, Show } from "solid-js";
import "./LoadRecoveryNotice.css";

export interface LoadRecoveryNoticeProps {
  /** Placements opening the project dropped because their clips were never saved. */
  readonly droppedPlacements: number;
}

/**
 * Tells the user that opening this project left something out (#965): the
 * last session closed before a save finished, so some clips in the
 * arrangement never reached the store. The project opens anyway, without
 * them, rather than refusing to open at all; this says so once, until
 * dismissed.
 */
export default function LoadRecoveryNotice(props: LoadRecoveryNoticeProps) {
  const [dismissed, setDismissed] = createSignal(false);
  const clips = () => (props.droppedPlacements === 1 ? "clip" : "clips");

  return (
    <Show when={props.droppedPlacements > 0 && !dismissed()}>
      <output class="load-recovery-notice" aria-live="polite">
        <p class="load-recovery-notice-text">
          This project was closed before its last save finished. {props.droppedPlacements}{" "}
          {clips()} in the arrangement never saved and
          {props.droppedPlacements === 1 ? " was" : " were"} left out. Everything else is
          here.
        </p>
        <button
          type="button"
          class="load-recovery-notice-dismiss"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </output>
    </Show>
  );
}
