import type { JSX } from "@solidjs/web";
import { MAX_TEMPO_BPM, MIN_TEMPO_BPM } from "../../audio/Transport";
import { useShortcutScope } from "../../shortcuts";

export interface TempoInputProps {
  /** The song's tempo, in BPM: what the box shows when it is not being edited. */
  readonly tempo: () => number;
  /** A finite tempo typed in; the command layer clamps it to the transport's range. */
  onTempoChange(bpm: number): void;
}

/**
 * The song's tempo, typed in place (the header's BPM box). Enter or focus
 * leaving commits a number through `onTempoChange`. An empty or non-numeric
 * entry commits nothing and puts the current tempo back, and Escape, while the
 * box has focus, is the registry's `view.close_surface`: it discards the typed
 * value and puts the current tempo back, as `ProjectNameInput` does.
 */
export default function TempoInput(props: TempoInputProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => {
          if (!input) return;
          input.value = String(props.tempo());
          input.blur();
        },
        isEnabled: () => input !== undefined && document.activeElement === input,
      },
    }),
    contexts: () => [],
  });

  return (
    <input
      ref={(el) => {
        input = el;
      }}
      id="tempo-input"
      aria-label="Tempo (BPM)"
      type="number"
      class="tempo-input"
      min={MIN_TEMPO_BPM}
      max={MAX_TEMPO_BPM}
      step={1}
      value={props.tempo()}
      onChange={(event) => {
        const bpm = event.currentTarget.valueAsNumber;
        if (Number.isFinite(bpm)) {
          props.onTempoChange(bpm);
        } else {
          // An empty or non-numeric entry is no tempo: the box shows the song's again.
          event.currentTarget.value = String(props.tempo());
        }
      }}
    />
  );
}
