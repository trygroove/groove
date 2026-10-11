import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ControlAddress } from "../commands/controlAddress";
import { control as controlRef } from "../controls/control";
import { ViewIcon } from "../editor/viewIcons";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { type SampleSlotId, useSampleSlotTargeting } from "./sampleSlotTargeting";
import "./SampleSlot.css";

export interface SampleSlotProps {
  /** What the slot is for, as its accessible name: "Sample for Kick". */
  readonly label: string;
  /** The sound loaded, or null when the slot is empty. */
  readonly name: string | null;
  /** What an empty slot says. Defaults to "No sample loaded". */
  readonly placeholder?: string;
  /** Which slot this is, so it can show when the Library is aimed at it. */
  readonly slot?: SampleSlotId;
  /**
   * The slot as a control (`UI-004`): the sound a pad or a sampler plays, so
   * it can be shown and outlined, as a sound tried from the assistant is
   * (GRV-23).
   */
  readonly control?: ControlAddress;
  /** Opens the library on this slot: the library is where sounds come from. */
  onBrowse(): void;
}

/**
 * The sample slot (#447): the one way to choose a sound from the library,
 * wherever an instrument holds one — the sampler's sample, every drum pad's,
 * and a loop track's loop. A filled button naming the sound, with the
 * Library's icon and its key, `4` (`UI-002`): pressing it goes to the Library
 * aimed at this slot. The slot the Library is aimed at is marked current, with
 * a white edge and a white key.
 */
export default function SampleSlot(props: SampleSlotProps): JSX.Element {
  const targeting = useSampleSlotTargeting();
  const isTarget = () => (props.slot ? targeting.isTarget(props.slot) : false);
  return (
    <button
      ref={controlRef(() => props.control)}
      type="button"
      class="sample-slot"
      aria-label={props.label}
      aria-current={isTarget() ? "true" : undefined}
      aria-keyshortcuts={targeting.keyLabel}
      onClick={() => props.onBrowse()}
    >
      <span class="sample-slot-icon">
        <ViewIcon view="library" size={14} />
      </span>
      {/* A sound's name is library copy, but a user-recorded sample lands in
          the same slot, so it is masked all the same (ADR 0002 decision 2). */}
      <span class={`sample-slot-name ${MASK_CONTENT}`}>
        {props.name ?? props.placeholder ?? "No sample loaded"}
      </span>
      <Show when={targeting.keyLabel}>
        {(key) => <kbd class="sample-slot-key">{key()}</kbd>}
      </Show>
    </button>
  );
}
