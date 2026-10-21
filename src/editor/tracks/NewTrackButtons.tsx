import { For, type JSX, Show } from "@solidjs/web";
import { HiSolidPlus } from "solid-icons/hi";
import { NEW_TRACK_KINDS, type NewTrackKindSpec } from "./trackCreation";
import "./NewTrackButtons.css";

export interface NewTrackButtonsProps {
  /** Names the group, so two of these on different views read differently. */
  readonly label: string;
  onAdd(spec: NewTrackKindSpec): void;
  /**
   * Offers the Loop button beside the kinds, opening the library on loops. An
   * audio track needs content to exist, so the way to start one is to pick the
   * loop (`UI-001`); inserting it makes the track (#281). Omitted, no button.
   */
  onAddLoop?(): void;
}

/**
 * One button per instrument kind, from the shared kind table (`UI-001`, #223).
 *
 * One button per kind rather than an "Add track" plus a picker: adding a track
 * is a two-decision action ("another track", "a sampler"), and a button per
 * kind makes the second decision the click itself instead of a mode set
 * beforehand.
 *
 * The mixer, the arrangement and the instrument view's rail all render this, so the kinds cannot drift
 * apart between the two surfaces, and both hand the click to the same
 * `addTrackOfKind` — there is one creation route, not one per surface.
 */
export default function NewTrackButtons(props: NewTrackButtonsProps): JSX.Element {
  return (
    <fieldset class="new-track-buttons" aria-label={props.label}>
      <For each={NEW_TRACK_KINDS}>
        {(spec) => (
          <button
            type="button"
            class="new-track-button"
            aria-label={spec.actionLabel}
            title={spec.actionLabel}
            onClick={() => props.onAdd(spec)}
          >
            <HiSolidPlus size={13} />
            <span>{spec.label}</span>
          </button>
        )}
      </For>
      <Show when={props.onAddLoop}>
        {(onAddLoop) => (
          <button
            type="button"
            class="new-track-button"
            aria-label="Add loop from library"
            title="Add a loop from the library"
            onClick={() => onAddLoop()()}
          >
            <HiSolidPlus size={13} />
            <span>Loop</span>
          </button>
        )}
      </Show>
    </fieldset>
  );
}
