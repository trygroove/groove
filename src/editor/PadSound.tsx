import { For, type JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import { setPadParameter } from "../commands";
import type { Asset, DrumPad, Track } from "../domain/entities";
import {
  PAD_ATTACK,
  PAD_DECAY,
  PAD_PITCH,
  type ParameterDefinition,
  TRACK_PAN,
  TRACK_VOLUME,
} from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import ControlGroup from "../instrument/ControlGroup";
import DragSurface from "../instrument/DragSurface";
import {
  FLOOR,
  PEAK,
  stageSeconds,
  stageWidth,
  svgPath,
} from "../instrument/envelopeGeometry";
import { createPeaks, peakBars, type WatchPeaks } from "../instrument/SampleWell";
import Well from "../instrument/Well";
import PadControl from "./PadControl";
import "./PadSound.css";

/** How much of the well the decay may take, after the attack's share. */
const DECAY_SHARE = 0.74;
const WIDTH = 300;
const HEIGHT = 90;

type PadParameterId = Parameters<typeof setPadParameter>[2];

export interface PadSoundProps {
  readonly track: Track;
  readonly pad: DrumPad;
  readonly asset: Asset | undefined;
  readonly watchPeaks?: WatchPeaks;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  onFirstUse(): void;
}

/** A pad parameter's current value: level and pan live on its mixer. */
function padValue(pad: DrumPad, definition: ParameterDefinition): number {
  if (definition.id === TRACK_VOLUME.id) return pad.mixer.volume;
  if (definition.id === TRACK_PAN.id) return pad.mixer.pan;
  const key = definition.id.slice("pad.".length);
  return pad.parameters[key] ?? definition.defaultValue;
}

/**
 * The selected pad's sound, in the editor above the drum table (#447): its sound drawn with the
 * attack and decay that shape each hit — both draggable on the well — and a
 * fader for each of its five values. Pad attack and decay were not reachable
 * from the panel before; pitch, level and pan are the row's own.
 */
export default function PadSound(props: PadSoundProps): JSX.Element {
  const peaks = createPeaks(
    () => props.watchPeaks,
    () => props.pad.assetId,
    150,
  );
  const attack = () => padValue(props.pad, PAD_ATTACK);
  const decay = () => padValue(props.pad, PAD_DECAY);

  const points = createMemo(() => {
    const a = stageWidth(attack(), PAD_ATTACK.max);
    const d = Math.sqrt(Math.min(decay(), PAD_DECAY.max) / PAD_DECAY.max) * DECAY_SHARE;
    return [
      [0, FLOOR],
      [a, PEAK],
      [Math.min(1, a + d), FLOOR],
      [1, FLOOR],
    ] as const;
  });

  const command = (definition: ParameterDefinition, value: number) =>
    setPadParameter(props.track.id, props.pad.id, definition.id as PadParameterId, value);

  const duration = () => props.asset?.durationSeconds ?? 0;
  const scale = () =>
    duration() > 0
      ? [0, 0.25, 0.5, 0.75, 1].map((f) => `${(duration() * f).toFixed(2)} s`)
      : undefined;

  /**
   * One of the pad's faders: the pad table's own control, standing. The
   * editor is the region named for its pad, so its faders need not say whose;
   * the row's copies of pitch, level and pan do.
   */
  function fader(definition: ParameterDefinition, label: string): JSX.Element {
    return (
      <PadControl
        trackId={props.track.id}
        pad={props.pad}
        definition={definition}
        label={label}
        ariaLabel={label}
        orientation="vertical"
        idPrefix="pad-sound"
        bipolar={definition.id === TRACK_PAN.id}
        value={padValue(props.pad, definition)}
        displayValue={formatReadout(definition, padValue(props.pad, definition))}
        onFirstUse={props.onFirstUse}
        dispatch={props.dispatch}
        beginGesture={props.beginGesture}
      />
    );
  }

  return (
    <div class="pad-sound">
      <Well
        title="Attack and decay · drag the corners"
        value={`${formatReadout(PAD_ATTACK, attack())} / ${formatReadout(PAD_DECAY, decay())}`}
        scale={scale()}
        class="pad-sound-well"
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            class="sample-well-bars"
            d={peaks() ? peakBars(peaks() as Float32Array, WIDTH, HEIGHT) : ""}
          />
          <path class="well-line" d={svgPath(points(), WIDTH, HEIGHT)} />
        </svg>
        <DragSurface
          grab={(point) =>
            Math.abs(point.x - points()[1][0]) <= Math.abs(point.x - points()[2][0])
              ? ("attack" as const)
              : ("decay" as const)
          }
          commands={(point, corner) => {
            if (corner === "attack") {
              return [command(PAD_ATTACK, stageSeconds(point.x, PAD_ATTACK.max))];
            }
            const share = Math.max(0, point.x - points()[1][0]) / DECAY_SHARE;
            const seconds = Math.min(1, share) ** 2 * PAD_DECAY.max;
            return [command(PAD_DECAY, Math.max(PAD_DECAY.min, seconds))];
          }}
          summary={() => "Shape a pad's hit"}
          dispatch={(commands) => props.dispatch(commands)}
          beginGesture={(options) => props.beginGesture(options)}
          onCommit={() => props.onFirstUse()}
        >
          <For each={[1, 2]}>
            {(index) => (
              <i
                class="drag-handle"
                style={{
                  left: `${points()[index][0] * 100}%`,
                  top: `${(1 - points()[index][1]) * 100}%`,
                }}
              />
            )}
          </For>
        </DragSurface>
      </Well>
      <ControlGroup title={`${props.pad.name} · sound`}>
        {fader(PAD_PITCH, "Pitch")}
        {fader(TRACK_VOLUME, "Level")}
        {fader(TRACK_PAN, "Pan")}
        {fader(PAD_ATTACK, "Attack")}
        {fader(PAD_DECAY, "Decay")}
      </ControlGroup>
    </div>
  );
}
