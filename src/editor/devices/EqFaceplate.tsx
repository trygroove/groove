import { For, type JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import {
  type DeviceChainTarget,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  setParameter,
  type TransactionResult,
} from "../../commands";
import {
  deviceParameters,
  EQ_BANDS,
  type EqBand,
  eqBandHasGain,
} from "../../domain/devices";
import type { Device } from "../../domain/entities";
import { bareParameterId, type ParameterDefinition } from "../../domain/parameters";
import { formatReadout } from "../../domain/valueFormat";
import DragSurface, {
  type SurfaceBox,
  type SurfacePoint,
} from "../../instrument/DragSurface";
import { frequencyAt, positionOf } from "../../instrument/filterResponse";
import Well from "../../instrument/Well";
import DeviceControls from "./DeviceControls";
import { deviceParameterTarget, readDeviceParameter } from "./deviceControlModel";
import { useDeviceSpectrum } from "./deviceSpectrum";
import EqSpectrum, { type FrameScheduler } from "./EqSpectrum";
import {
  dbAt,
  dbDepth,
  type EqHandle,
  eqCurvePath,
  eqHandles,
  nearestBand,
} from "./eqCurve";
import "./EqFaceplate.css";

export interface EqFaceplateProps {
  readonly chain: DeviceChainTarget;
  readonly device: Device;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** The spectrum's frame scheduler; injectable for tests. */
  readonly frames?: FrameScheduler;
}

/** The band a press picked, and its handle's offset from the pointer. */
interface Grabbed {
  readonly band: EqBand;
  readonly dx: number;
  readonly dy: number;
}

const WIDTH = 300;
const HEIGHT = 100;
const DECADES = [100, 1_000, 10_000];
const DB_LINES = [12, 0, -12];

/**
 * The EQ's faceplate (LOOP-022, #447): its response curve in a well over a
 * live spectrum of what leaves it, a handle per band to drag, and the controls
 * of the band being edited.
 *
 * Dragging a handle moves its band's frequency left and right and, for a
 * shelf or a peak, its gain up and down, from where the handle was: it does not
 * jump under the pointer. Dragging a band that is switched off switches it in,
 * since moving it is asking to hear it. A press picks the band the controls
 * beside the well show, as choosing it in the band strip does, and a click
 * that never moves does nothing more: no edit, no history entry. Which band
 * is being edited is the faceplate's own passing state, not the project's:
 * every value it shows and every edit it makes is the device's
 * `parameter.set`, the same command its faders write.
 */
export default function EqFaceplate(props: EqFaceplateProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;
  const spectrum = useDeviceSpectrum();
  const [selected, setSelected] = createSignal<string>("peak1");
  const band = () => EQ_BANDS.find((b) => b.id === selected()) ?? EQ_BANDS[0];

  const definition = (id: string) =>
    deviceParameters("eq").find(
      (d) => bareParameterId(d.id) === id,
    ) as ParameterDefinition;
  const value = (id: string) => readDeviceParameter(props.device, definition(id));
  const values = () => {
    const all: Record<string, number> = {};
    for (const d of deviceParameters("eq"))
      all[bareParameterId(d.id)] = value(bareParameterId(d.id));
    return all;
  };
  const command = (id: string, next: number) =>
    setParameter(deviceParameterTarget(props.chain, props.device.id, id), next);
  const clamped = (id: string, next: number) => {
    const d = definition(id);
    return Math.min(d.max, Math.max(d.min, next));
  };

  const handles = () => eqHandles(values());
  const curve = () => eqCurvePath(values(), WIDTH, HEIGHT);

  /** "Peak 1 · 500 Hz · +3.0 dB · Q 1.00" — the band being edited, in words. */
  const readout = () => {
    const b = band();
    const show = (id: string) => formatReadout(definition(id), value(id));
    const parts = [b.label, show(`${b.id}Freq`)];
    if (eqBandHasGain(b.kind)) parts.push(show(`${b.id}Gain`));
    parts.push(`Q ${show(`${b.id}Q`)}`);
    if (value(`${b.id}On`) < 0.5) parts.push("off");
    return parts.join(" · ");
  };

  /**
   * The press: picks the nearest band, and how far its handle sits from the
   * pointer, so the drag carries the handle from where it is rather than
   * jumping it under the pointer.
   */
  const grab = (point: SurfacePoint, box: SurfaceBox): Grabbed => {
    const all = handles();
    const picked = nearestBand(point, all, box.height > 0 ? box.width / box.height : 1);
    setSelected(picked.id);
    const handle = all.find((h) => h.band.id === picked.id) as EqHandle;
    return { band: picked, dx: handle.x - point.x, dy: 1 - handle.y - point.y };
  };

  /** The edits that move `grabbed` with the pointer, switching it in if it was out. */
  const dragCommands = (point: SurfacePoint, grabbed: Grabbed) => {
    const id = grabbed.band.id;
    const x = Math.min(1, Math.max(0, point.x + grabbed.dx));
    const y = Math.min(1, Math.max(0, point.y + grabbed.dy));
    const commands = [command(`${id}Freq`, clamped(`${id}Freq`, frequencyAt(x)))];
    if (eqBandHasGain(grabbed.band.kind)) {
      commands.push(command(`${id}Gain`, clamped(`${id}Gain`, dbAt(y))));
    }
    if (value(`${id}On`) < 0.5) commands.push(command(`${id}On`, 1));
    return commands;
  };

  return (
    <div class="eq-faceplate">
      <Well
        title="EQ · drag a band"
        value={readout()}
        scale={["20", "100", "1k", "10k", "20k"]}
        class="eq-well"
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <For each={DECADES}>
            {(hz) => {
              const x = positionOf(hz) * WIDTH;
              return <line class="well-grid" x1={x} x2={x} y1="0" y2={HEIGHT} />;
            }}
          </For>
          <For each={DB_LINES}>
            {(db) => {
              const y = dbDepth(db) * HEIGHT;
              return (
                <line
                  class={["well-grid", { "eq-zero": db === 0 }]}
                  x1="0"
                  x2={WIDTH}
                  y1={y}
                  y2={y}
                />
              );
            }}
          </For>
          {spectrum && (
            <EqSpectrum
              deviceId={props.device.id}
              source={spectrum}
              width={WIDTH}
              height={HEIGHT}
              frames={props.frames}
            />
          )}
          <path
            class="well-area"
            d={`${curve()} L${WIDTH},${dbDepth(0) * HEIGHT} L0,${dbDepth(0) * HEIGHT} Z`}
          />
          <path class="well-line" d={curve()} />
        </svg>
        <DragSurface
          grab={grab}
          startOnMove
          commands={dragCommands}
          summary={() => `Shape ${band().label.toLowerCase()}`}
          dispatch={(commands) => props.dispatch(commands)}
          beginGesture={(options) => props.beginGesture(options)}
          onCommit={() => analytics().logFeatureFirstUse("eq_curve")}
        >
          <For each={handles()} keyed={(handle) => handle.band.id}>
            {(handle) => (
              <i
                class={[
                  "eq-handle",
                  { active: handle().band.id === selected(), off: !handle().on },
                ]}
                style={{ left: `${handle().x * 100}%`, top: `${handle().y * 100}%` }}
              >
                {handle().band.short}
              </i>
            )}
          </For>
        </DragSurface>
      </Well>
      <div class="eq-editor">
        <fieldset class="eq-bands" aria-label="Band">
          <For each={EQ_BANDS}>
            {(b) => (
              <label
                class={[
                  "eq-band",
                  { active: b.id === selected(), off: value(`${b.id}On`) < 0.5 },
                ]}
                title={b.label}
              >
                <input
                  type="radio"
                  class="option-group-input"
                  name={`eq-band-${props.device.id}`}
                  aria-label={b.label}
                  checked={b.id === selected()}
                  onChange={() => setSelected(b.id)}
                />
                <span aria-hidden="true">{b.short}</span>
              </label>
            )}
          </For>
        </fieldset>
        <DeviceControls
          chain={props.chain}
          device={props.device}
          only={[
            `${band().id}On`,
            `${band().id}Freq`,
            `${band().id}Gain`,
            `${band().id}Q`,
            "output",
          ]}
          dispatch={props.dispatch}
          beginGesture={props.beginGesture}
        />
      </div>
    </div>
  );
}
