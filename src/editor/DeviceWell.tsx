import { For, type JSX } from "@solidjs/web";
import { untrack } from "solid-js";
import type {
  DeviceChainTarget,
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import { setParameter } from "../commands";
import { delayDivision, deviceParameters, FILTER_MODES } from "../domain/devices";
import type { Device } from "../domain/entities";
import { bareParameterId, type ParameterDefinition } from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import DragSurface from "../instrument/DragSurface";
import FilterWell from "../instrument/FilterWell";
import Well from "../instrument/Well";
import { deviceParameterTarget, readDeviceParameter } from "./deviceControlModel";
import {
  COMPRESSOR_CEILING_DB,
  COMPRESSOR_FLOOR_DB,
  compressorOutput,
  compressorPath,
  compressorPosition,
  DELAY_WINDOW,
  delayEchoes,
  delayTime,
  overdriveTransfer,
  REVERB_WINDOW,
  reverbTailPath,
  reverbTiming,
  saturatorTransfer,
  transferPath,
} from "./deviceDrawings";
import LimiterWell from "./LimiterWell";

export interface DeviceWellProps {
  readonly chain: DeviceChainTarget;
  readonly device: Device;
  /** The song's tempo, for a synced delay's echo times. Defaults to 120. */
  readonly tempo?: number;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/** A device type's parameter by its bare id. */
function parameter(type: string, id: string): ParameterDefinition | undefined {
  return deviceParameters(type).find(
    (definition) => bareParameterId(definition.id) === id,
  );
}

/** Which compressor handle a press is nearer: the knee's or the curve's end. */
function grabbedCompressor(
  point: { readonly x: number; readonly y: number },
  handles: readonly (readonly [number, number])[],
): "threshold" | "ratio" {
  const near = (h: readonly [number, number]) =>
    Math.hypot(h[0] - point.x, 1 - h[1] - point.y);
  return near(handles[0]) <= near(handles[1]) ? "threshold" : "ratio";
}

/** Normalised position of `value` along `definition`'s range. */
const along = (definition: ParameterDefinition, value: number) =>
  (value - definition.min) / (definition.max - definition.min);
/** The value at `position` (0..1) along `definition`'s range. */
const at = (definition: ParameterDefinition, position: number) =>
  definition.min + position * (definition.max - definition.min);

const WIDTH = 300;
const HEIGHT = 100;

/**
 * A well with one point to drag between two parameters, over whatever it
 * draws: left and right set `x`, up and down `y`.
 */
function PointWell(props: {
  readonly title: string;
  readonly readout: string;
  readonly scale?: readonly string[];
  readonly class: string;
  readonly x: ParameterDefinition;
  readonly y: ParameterDefinition;
  readonly values: { readonly x: number; readonly y: number };
  /**
   * Where `x`'s value sits across the well, and back, when that is not simply
   * along its range — a reverb's point sits where its tail ends.
   */
  readonly xAxis?: { at(value: number): number; value(position: number): number };
  readonly children: JSX.Element;
  command(definition: ParameterDefinition, value: number): RawCommandInput;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}): JSX.Element {
  return (
    <Well
      title={props.title}
      value={props.readout}
      scale={props.scale}
      class={props.class}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {props.children}
      </svg>
      <DragSurface
        grab={() => "point" as const}
        commands={(point) => [
          props.command(
            props.x,
            props.xAxis ? props.xAxis.value(point.x) : at(props.x, point.x),
          ),
          props.command(props.y, at(props.y, point.y)),
        ]}
        summary={() => `Shape ${props.title.toLowerCase()}`}
        dispatch={(commands) => props.dispatch(commands)}
        beginGesture={(options) => props.beginGesture(options)}
      >
        <i
          class="drag-handle"
          style={{
            left: `${(props.xAxis ? props.xAxis.at(props.values.x) : along(props.x, props.values.x)) * 100}%`,
            top: `${(1 - along(props.y, props.values.y)) * 100}%`,
          }}
        />
      </DragSurface>
    </Well>
  );
}

const WELL_TYPES = new Set([
  "filter",
  "overdrive",
  "saturator",
  "compressor",
  "delay",
  "reverb",
  "limiter",
]);

/** Whether `device` has a well yet; one without gives its banks the card. */
export function hasDeviceWell(device: Device): boolean {
  return WELL_TYPES.has(device.type);
}

/**
 * The well that draws what a device does to the sound (#447). Its drags write
 * the same `parameter.set` the device's faders do.
 */
export default function DeviceWell(props: DeviceWellProps): JSX.Element {
  const value = (definition: ParameterDefinition) =>
    readDeviceParameter(props.device, definition);
  const command = (definition: ParameterDefinition, next: number) =>
    setParameter(
      deviceParameterTarget(props.chain, props.device.id, bareParameterId(definition.id)),
      next,
    );
  const edits = {
    command,
    dispatch: (commands: RawCommandInput | readonly RawCommandInput[]) =>
      props.dispatch(commands),
    beginGesture: (options?: GestureOptions) => props.beginGesture(options),
  };
  // The panel keys its cards on the device's id, and a device never changes
  // type, so which well to draw is decided once, knowingly untracked (#844).
  const type = untrack(() => props.device.type);
  const p = (id: string) => parameter(type, id) as ParameterDefinition;
  const show = (definition: ParameterDefinition) =>
    formatReadout(definition, value(definition));

  if (type === "overdrive" || type === "saturator") {
    const x = type === "overdrive" ? p("tone") : p("character");
    const y = p("drive");
    const curve = () =>
      type === "overdrive"
        ? (input: number) => overdriveTransfer(value(y), input)
        : (input: number) => saturatorTransfer(value(y), value(x), input);
    return (
      <PointWell
        title="Transfer"
        readout={`${show(y)} drive`}
        scale={["In −1", "0", "+1"]}
        class="transfer-well"
        x={x}
        y={y}
        values={{ x: value(x), y: value(y) }}
        {...edits}
      >
        <line class="well-grid" x1={WIDTH / 2} x2={WIDTH / 2} y1="0" y2={HEIGHT} />
        <line class="well-grid" x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />
        <path class="well-line" d={transferPath(curve(), WIDTH, HEIGHT)} />
      </PointWell>
    );
  }

  if (type === "limiter") return <LimiterWell device={props.device} />;

  if (type === "compressor") {
    const threshold = p("threshold");
    const ratio = p("ratio");
    const makeup = p("makeup");
    const handles = () => {
      const t = value(threshold);
      const top = (db: number) =>
        1 - compressorPosition(db, COMPRESSOR_FLOOR_DB, COMPRESSOR_CEILING_DB);
      return [
        [compressorPosition(t), top(t + value(makeup))],
        [1, top(compressorOutput(0, t, value(ratio), value(makeup)))],
      ] as const;
    };
    return (
      <Well
        title="Curve"
        value={`${show(threshold)} · ${show(ratio)}`}
        scale={["−60", "−45", "−30", "−15", "0 dB in"]}
        class="compressor-well"
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            class="well-grid"
            x1="0"
            x2={WIDTH}
            y1={
              (1 - compressorPosition(0, COMPRESSOR_FLOOR_DB, COMPRESSOR_CEILING_DB)) *
              HEIGHT
            }
            y2={
              (1 - compressorPosition(0, COMPRESSOR_FLOOR_DB, COMPRESSOR_CEILING_DB)) *
              HEIGHT
            }
          />
          <path
            class="well-line"
            d={compressorPath(
              value(threshold),
              value(ratio),
              value(makeup),
              WIDTH,
              HEIGHT,
            )}
          />
        </svg>
        <DragSurface
          grab={(point) => grabbedCompressor(point, handles())}
          commands={(point, handle) => {
            if (handle === "threshold") {
              return [command(threshold, at(threshold, point.x))];
            }
            // The ratio that puts 0 dB in at the height pressed.
            const outAtZero =
              COMPRESSOR_FLOOR_DB +
              point.y * (COMPRESSOR_CEILING_DB - COMPRESSOR_FLOOR_DB);
            const rise = outAtZero - value(makeup) - value(threshold);
            const next = rise <= 0 ? ratio.max : -value(threshold) / rise;
            return [command(ratio, Math.min(ratio.max, Math.max(ratio.min, next)))];
          }}
          summary={() => "Shape compressor"}
          dispatch={(commands) => props.dispatch(commands)}
          beginGesture={(options) => props.beginGesture(options)}
        >
          <For each={[0, 1]}>
            {(index) => (
              <i
                class="drag-handle"
                style={{
                  left: `${handles()[index][0] * 100}%`,
                  top: `${handles()[index][1] * 100}%`,
                }}
              />
            )}
          </For>
        </DragSurface>
      </Well>
    );
  }

  if (type === "delay") {
    const sync = p("sync");
    const division = p("division");
    const time = p("time");
    const feedback = p("feedback");
    const spread = p("spread");
    const synced = () => value(sync) >= 0.5;
    const seconds = (divisionIndex: number, free: number) =>
      delayTime(
        synced(),
        free,
        delayDivision(divisionIndex).wholeNotes,
        props.tempo ?? 120,
      );
    const current = () => seconds(value(division), value(time));
    const tapPath = (side: "left" | "right") =>
      delayEchoes(current(), value(feedback), value(spread))
        .filter((echo) => echo.side === side)
        .map((echo) => {
          const x = ((echo.at / DELAY_WINDOW) * WIDTH).toFixed(1);
          const reach = echo.level * HEIGHT * 0.45;
          const [from, to] =
            side === "left"
              ? [HEIGHT / 2 - reach, HEIGHT / 2]
              : [HEIGHT / 2, HEIGHT / 2 + reach];
          return `M${x},${from.toFixed(1)}V${to.toFixed(1)}`;
        })
        .join("");
    const x = () => (synced() ? division : time);
    return (
      <PointWell
        title="Echoes"
        readout={`${synced() ? `${delayDivision(value(division)).label} · ` : ""}${formatReadout(time, current())}`}
        scale={["0", "0.5 s", "1 s", "1.5 s", "2 s"]}
        class="delay-well"
        x={x()}
        y={feedback}
        values={{ x: value(x()), y: value(feedback) }}
        xAxis={{
          at: () => Math.min(1, current() / DELAY_WINDOW),
          value: (position) => {
            const wanted = position * DELAY_WINDOW;
            if (!synced()) return Math.min(time.max, Math.max(time.min, wanted));
            // The division whose echo lands nearest the press.
            let nearest = division.min;
            for (let i = division.min; i <= division.max; i++) {
              if (
                Math.abs(seconds(i, 0) - wanted) < Math.abs(seconds(nearest, 0) - wanted)
              ) {
                nearest = i;
              }
            }
            return nearest;
          },
        }}
        {...edits}
      >
        <line class="well-grid" x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />
        <path class="well-line delay-well-taps" d={tapPath("left")} />
        <path class="well-line delay-well-taps" d={tapPath("right")} />
      </PointWell>
    );
  }

  if (type === "reverb") {
    const decay = p("decay");
    const size = p("size");
    const predelay = p("predelay");
    return (
      <PointWell
        title="Tail"
        readout={`${show(decay)} · ${show(size)}`}
        scale={["0", "2 s", "4 s", "6 s", "8 s"]}
        class="reverb-well"
        x={decay}
        y={size}
        values={{ x: value(decay), y: value(size) }}
        xAxis={{
          at: (seconds) => {
            const timing = reverbTiming(seconds, value(size), value(predelay));
            return Math.min(1, (timing.predelay + timing.decay) / REVERB_WINDOW);
          },
          value: (position) => {
            const { predelay: start } = reverbTiming(0, value(size), value(predelay));
            const seconds = (position * REVERB_WINDOW - start) / (0.5 + value(size));
            return Math.min(decay.max, Math.max(decay.min, seconds));
          },
        }}
        {...edits}
      >
        <path
          class="well-area"
          d={reverbTailPath(value(decay), value(size), value(predelay), WIDTH, HEIGHT)}
        />
        <path
          class="well-line"
          d={reverbTailPath(value(decay), value(size), value(predelay), WIDTH, HEIGHT)}
        />
      </PointWell>
    );
  }
  const cutoff = parameter("filter", "cutoff");
  const resonance = parameter("filter", "resonance");
  const mode = parameter("filter", "mode");
  if (type !== "filter" || !cutoff || !resonance || !mode) return null;
  const shape = () => FILTER_MODES[Math.round(value(mode))] ?? "lowpass";

  return (
    <FilterWell
      shape={shape()}
      cutoff={cutoff}
      resonance={resonance}
      values={{ cutoff: value(cutoff), resonance: value(resonance) }}
      readout={`${formatReadout(cutoff, value(cutoff))} · Q ${formatReadout(resonance, value(resonance))}`}
      command={command}
      dispatch={(commands) => props.dispatch(commands)}
      beginGesture={(options) => props.beginGesture(options)}
    />
  );
}
