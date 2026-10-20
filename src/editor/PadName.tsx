import { type JSX, Show } from "@solidjs/web";
import { HiSolidPlay } from "solid-icons/hi";
import { createSignal } from "solid-js";
import type { RawCommandInput, TransactionResult } from "../commands";
import { renamePad } from "../commands";
import type { DrumPad, Track } from "../domain/entities";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { useShortcutScope } from "../shortcuts";
import { MAX_DISPLAY_NAME_LENGTH } from "./displayNameLimit";
import "./PadName.css";

export interface PadNameProps {
  readonly track: Track;
  readonly pad: DrumPad;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Whether this is the selected pad: its audition button reads pressed. */
  readonly selected?: boolean;
  /** Plays the pad; the small button beside the name. */
  onAudition(): void;
  /** A name was committed through the command layer. */
  onRenamed?(): void;
}

/**
 * A pad's name in the pad table: a button that swaps to an inline text input
 * (Enter/Space on the button opens it, like a click), plus a separate play
 * button that auditions the pad. Enter or blur commits one `drum.renamePad`;
 * an empty or unchanged name commits nothing. Escape, while the input has
 * focus, is the registry's `view.close_surface`, as in `TrackNameInput`.
 */
export default function PadName(props: PadNameProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let nameButton: HTMLButtonElement | undefined;
  // Set once an edit has committed or cancelled, so `change` then `blur` (or
  // Escape's own blur) never commits twice.
  let settled = true;

  function done(): void {
    setEditing(false);
    // Enter and Escape leave focus nowhere; hand it back to the name button.
    queueMicrotask(() => {
      const active = document.activeElement;
      if (!active || active === document.body) nameButton?.focus();
    });
  }

  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => {
          if (!input) return;
          input.value = props.pad.name;
          settled = true;
          input.blur();
          done();
        },
        isEnabled: () => input !== undefined && document.activeElement === input,
      },
    }),
    contexts: () => [],
  });

  function commit(value: string): void {
    if (settled) return;
    settled = true;
    const name = value.trim();
    if (name && name !== props.pad.name) {
      if (props.dispatch(renamePad(props.track.id, props.pad.id, name))?.ok) {
        props.onRenamed?.();
      }
    }
    done();
  }

  return (
    <div class="pad-name-cell">
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            class="pad-rename"
            ref={(el) => {
              nameButton = el;
            }}
            onClick={() => {
              settled = false;
              setEditing(true);
            }}
            aria-label={`Rename ${props.pad.name}`}
            title={`Rename ${props.pad.name}`}
          >
            <span class={`pad-name ${MASK_CONTENT}`}>{props.pad.name}</span>
          </button>
        }
      >
        <input
          ref={(el) => {
            input = el;
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          class={`pad-name-input ${MASK_CONTENT}`}
          type="text"
          maxlength={MAX_DISPLAY_NAME_LENGTH}
          aria-label={`Name of ${props.pad.name}`}
          value={props.pad.name}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => commit(event.currentTarget.value)}
          onBlur={(event) => {
            // Enter and a changed value commit through `change`; this covers
            // an unchanged or emptied name that ends the edit by leaving.
            commit(event.currentTarget.value);
          }}
        />
      </Show>
      <button
        type="button"
        class="pad-audition"
        onClick={(event) => {
          event.stopPropagation();
          props.onAudition();
        }}
        aria-label={`Audition ${props.pad.name}`}
        aria-pressed={props.selected ? "true" : "false"}
        title={`Audition ${props.pad.name}`}
      >
        <HiSolidPlay size={12} />
      </button>
    </div>
  );
}
