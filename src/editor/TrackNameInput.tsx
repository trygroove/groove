import type { JSX } from "@solidjs/web";
import type { RawCommandInput, TransactionResult } from "../commands";
import { updateTrack } from "../commands";
import type { Track } from "../domain/entities";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { useShortcutScope } from "../shortcuts";
import { MAX_DISPLAY_NAME_LENGTH } from "./displayNameLimit";

export interface TrackNameInputProps {
  readonly track: Track;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Extra classes; the name is always masked from session replay. */
  readonly class: string;
  /** An accessible name, for a surface with no visible label of its own. */
  readonly label?: string;
  /** Focus and select the name on mount: rename opened by a click. */
  readonly autofocus?: boolean;
  /** The edit is over: committed, cancelled, or focus left. */
  onDone?(): void;
}

/**
 * A track's name, typed in place: the one rename control the mixer strip and
 * the track header share. A change (Enter, or focus leaving) commits one
 * `track.update` through the command layer; an empty or unchanged name puts
 * the track's own back. Escape, while the name has focus, is the registry's
 * `view.close_surface`: it puts the track's own name back and ends the edit.
 */
export default function TrackNameInput(props: TrackNameInputProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => {
          if (!input) return;
          input.value = props.track.name;
          input.blur();
          props.onDone?.();
        },
        isEnabled: () => input !== undefined && document.activeElement === input,
      },
    }),
    contexts: () => [],
  });

  return (
    // The track's name, typed here (ADR 0002 decision 2). The rest of the
    // surface stays visible — that is the mixing replay exists to observe.
    <input
      ref={(el) => {
        input = el;
        if (props.autofocus) {
          queueMicrotask(() => {
            el.focus();
            el.select();
          });
        }
      }}
      id={`track-name-${props.track.id}`}
      class={`${props.class} ${MASK_CONTENT}`}
      type="text"
      maxlength={MAX_DISPLAY_NAME_LENGTH}
      aria-label={props.label}
      value={props.track.name}
      onBlur={() => {
        props.onDone?.();
      }}
      onChange={(event) => {
        const name = event.currentTarget.value.trim();
        if (name && name !== props.track.name) {
          props.dispatch(updateTrack(props.track.id, { name }));
        } else {
          event.currentTarget.value = props.track.name;
        }
        props.onDone?.();
      }}
    />
  );
}
