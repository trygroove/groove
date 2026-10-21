import { type Accessor, createSignal } from "solid-js";
import { BEATS_PER_BAR } from "../../domain/time";
import {
  normalizePlayheadSegments,
  type PlayheadSegments,
  playheadLabel,
  playheadSegments,
  playheadSegmentsToTicks,
} from "../composition/editorViewModel";

export interface PlayheadInputProps {
  readonly positionTicks: Accessor<number>;
  /** Jump the transport to a tick. Called once per committed edit. */
  readonly onSeek: (ticks: number) => void;
}

type Segment = keyof PlayheadSegments;

/**
 * The playhead as a segmented bar.beat input (#340): it reads the transport
 * position like the readout it replaced, and committing either segment jumps
 * the playhead there.
 *
 * While a segment has focus the shown position is held, so a running
 * transport never overwrites what the user is typing; a commit moves the hold
 * to the position it seeked to. It also writes the normalized value straight
 * back into the field, because a clamped value that lands on the position
 * already shown changes nothing reactive and would leave the typed text behind.
 *
 * The visually-hidden "Playhead at bar …" text is the readout's accessible
 * text; the core-flow specs locate the playhead by it.
 */
export default function PlayheadInput(props: PlayheadInputProps) {
  const [held, setHeld] = createSignal<PlayheadSegments | null>(null);
  const shown = () => held() ?? playheadSegments(props.positionTicks());

  function commit(segment: Segment, input: HTMLInputElement): void {
    const typed = { ...shown(), [segment]: input.valueAsNumber };
    const next = normalizePlayheadSegments(typed.bar, typed.beat);
    input.value = String((next ?? shown())[segment]);
    if (!next) return;
    if (held()) setHeld(next);
    props.onSeek(playheadSegmentsToTicks(next));
  }

  const field = (segment: Segment, label: string, max?: number) => (
    <input
      type="number"
      class={`playhead-segment playhead-${segment}`}
      aria-label={label}
      min={1}
      max={max}
      step={1}
      value={shown()[segment]}
      onFocus={() => setHeld(playheadSegments(props.positionTicks()))}
      onBlur={() => setHeld(null)}
      onChange={(event) => commit(segment, event.currentTarget)}
    />
  );

  return (
    <fieldset class="playhead-position" aria-label="Playhead" title="Playhead (bar.beat)">
      <span class="visually-hidden">
        Playhead at bar {playheadLabel(props.positionTicks())}
      </span>
      {field("bar", "Bar")}
      {/* The dot is drawn by CSS so the group's text stays the readout alone. */}
      <span class="playhead-separator" aria-hidden="true" />
      {field("beat", "Beat", BEATS_PER_BAR)}
    </fieldset>
  );
}
