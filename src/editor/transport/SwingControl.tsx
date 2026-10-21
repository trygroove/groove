import type { JSX } from "@solidjs/web";
import type { Accessor } from "solid-js";
import { parameterControl, SONG_ENTITY } from "../../commands/controlAddress";
import type { ControlSettle } from "../../commands/controlGesture";
import { SONG_SWING } from "../../domain/parameters";
import FillSlider from "../../instrument/FillSlider";

export interface SwingControlProps {
  /** The song's swing, 50-75 (%). */
  readonly swing: Accessor<number>;
  /** Called with each in-range value while the slider moves. */
  onInput(value: number): void;
  /** Called once when the drag, keystroke or typed value settles. */
  onCommit(value: number, settle: ControlSettle): void;
}

/**
 * The song's one swing knob (#500), beside tempo in the transport toolbar.
 * It is the shared horizontal `FillSlider`, so it is a real range input:
 * arrow keys nudge it by a percent, a drag is one gesture, a typed value or a
 * double-click lands as one edit, and it reads out `62%` beside its label.
 */
export default function SwingControl(props: SwingControlProps): JSX.Element {
  return (
    <div class="swing-control">
      <FillSlider
        definition={SONG_SWING}
        control={parameterControl(SONG_ENTITY, SONG_SWING.id)}
        value={props.swing()}
        inputId="swing-input"
        label="Swing"
        displayValue={`${Math.round(props.swing())}%`}
        orientation="horizontal"
        onInput={(value) => props.onInput(value)}
        onCommit={(value, settle) => props.onCommit(value, settle)}
      />
    </div>
  );
}
