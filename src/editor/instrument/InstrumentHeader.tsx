import { For, type JSX, Show } from "@solidjs/web";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";
import type { InstrumentHeaderFacts } from "./instrumentHeader";
import "./InstrumentHeader.css";

export interface InstrumentHeaderProps {
  readonly facts: InstrumentHeaderFacts;
  /** The track's name, chosen by the user (ADR 0002). */
  readonly trackName: string;
  /** The track's live level, beside Audition (#447). */
  readonly meter?: JSX.Element;
  /** The loud action at the right edge, when this instrument can be heard. */
  readonly audition?: { readonly label: string; run(): void };
}

/**
 * The instrument's header row (#447): the track's colour edge, its slot and
 * kind over its name, a few key readouts, and Audition, bold at the right.
 */
export default function InstrumentHeader(props: InstrumentHeaderProps): JSX.Element {
  return (
    <header class="instrument-header">
      <div class="instrument-header-track">
        <span class="instrument-header-label">
          {props.facts.slot} · {props.facts.kind}
        </span>
        {/* The view's one h2 (#76): every panel's heading under it, the
            instrument picker's included, is an h3, as a return's are under
            its name (`ReturnPanel`). */}
        <h2 class={`instrument-header-name ${MASK_CONTENT}`}>{props.trackName}</h2>
      </div>
      <dl class="instrument-header-readouts">
        <For each={props.facts.readouts}>
          {(readout) => (
            <div class="instrument-header-readout">
              <dt class="instrument-header-label">{readout.label}</dt>
              <dd class={readout.masked ? MASK_CONTENT : undefined}>{readout.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <div class="instrument-header-end">
        {props.meter}
        <Show when={props.audition}>
          {(audition) => (
            <button
              type="button"
              class="instrument-header-audition"
              onClick={() => audition().run()}
            >
              {audition().label}
            </button>
          )}
        </Show>
      </div>
    </header>
  );
}
