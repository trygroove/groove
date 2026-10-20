import { For, type JSX, Show } from "@solidjs/web";
import { createMemo } from "solid-js";
import {
  createControlGesture,
  type DeviceChainTarget,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  setParameter,
  type TransactionResult,
} from "../commands";
import { type ControlAddress, parameterControl } from "../commands/controlAddress";
import { deviceParameters } from "../domain/devices";
import type { Device } from "../domain/entities";
import {
  bareParameterId,
  clampParameterValue,
  type ParameterDefinition,
} from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import ControlGroup from "../instrument/ControlGroup";
import FillSlider from "../instrument/FillSlider";
import OptionGroup from "../instrument/OptionGroup";
import {
  deviceChoices,
  deviceParameterTarget,
  readDeviceControl,
  readDeviceParameter,
} from "./deviceControlModel";
import "./DeviceControls.css";
import { deviceGroups } from "./deviceFaceplate";

export interface DeviceControlsProps {
  /** The chain the device is in, which decides its parameters' address. */
  readonly chain: DeviceChainTarget;
  readonly device: Device;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The song's tempo, so a synced delay's Time shows its real time. Defaults to 120. */
  readonly tempo?: number;
  /**
   * Only these parameters, by bare id, when the device shows a part of its
   * controls at a time — the EQ shows the band it is editing (LOOP-022).
   */
  readonly only?: readonly string[];
}

/**
 * One insert device's own controls, built from its parameter definitions
 * (PRD FX-01: "musically relevant controls, not a preset picker").
 *
 * Every control writes through `parameter.set` — `trackDevice` for a track's
 * inserts, `masterDevice` for the master's — the same shared command an
 * instrument slider uses, so a device edit is
 * validated, clamped by its definition, undoable and saved like any other. A
 * slider drag is one gesture (`createControlGesture`): it applies live, so the
 * fill and the audio follow the pointer, and the release commits the whole
 * drag as one history entry, one revision and one save. A mode choice is one
 * plain command.
 *
 * Element ids and radio names carry the device's id, because a chain may hold
 * two of the same device — a duplicated reverb has a second "Size".
 *
 * The controls stand in Juno-style banks (#447, `deviceFaceplate.ts`): a mode
 * is a switch as tall as the faders, and each bank's width follows its number
 * of controls, so every fader on a card sits on one pitch.
 */
export default function DeviceControls(props: DeviceControlsProps): JSX.Element {
  const command = (definition: ParameterDefinition, value: number) =>
    setParameter(
      deviceParameterTarget(props.chain, props.device.id, bareParameterId(definition.id)),
      value,
    );
  const key = (definition: ParameterDefinition) =>
    `device-${props.device.id}-${bareParameterId(definition.id)}`;

  // Grouped once per device type, not per edit: a new list on every value
  // change would remount the banks — and the slider being dragged with them.
  const type = createMemo(() => props.device.type);
  const only = createMemo(() => props.only?.join(" "));
  const groups = createMemo(() => {
    const shown = only()?.split(" ");
    const definitions = deviceParameters(type()).filter(
      (definition) => !shown || shown.includes(bareParameterId(definition.id)),
    );
    return deviceGroups(type(), definitions);
  });

  const control = (definition: ParameterDefinition, group: string): JSX.Element => {
    const value = () => readDeviceParameter(props.device, definition);
    const reading = () => readDeviceControl(props.device, definition, props.tempo ?? 120);
    const choices = deviceChoices(definition);
    return (
      <Show
        when={choices}
        fallback={
          <DeviceSlider
            definition={definition}
            control={parameterControl(props.device.id, definition.id)}
            label={controlLabel(group, definition.label)}
            value={reading().value}
            derived={reading().derived}
            inputId={key(definition)}
            command={(next) => command(definition, next)}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
          />
        }
      >
        {(options) => (
          <OptionGroup
            legend={definition.label}
            control={parameterControl(props.device.id, definition.id)}
            radioGroup={key(definition)}
            fill
            value={value()}
            options={options()}
            onSelect={(next) => props.dispatch(command(definition, next))}
          />
        )}
      </Show>
    );
  };

  return (
    <div class="device-controls">
      <For each={groups()}>
        {(group) => (
          <ControlGroup
            title={group.title}
            plainTitle
            class={
              group.parameters.some((d) => deviceChoices(d)) ? "device-switch" : undefined
            }
            style={{ "--controls": String(group.parameters.length) }}
          >
            <For each={group.parameters}>
              {(definition) => control(definition, group.title)}
            </For>
          </ControlGroup>
        )}
      </For>
    </div>
  );
}

/**
 * A control's name inside its bank, where the bank already says whose it is:
 * the EQ's "Low shelf gain" reads "Gain" under "Low shelf". The full name stays
 * the control's accessible name, so it is still unambiguous to a screen reader.
 */
export function controlLabel(group: string, label: string): string {
  const prefix = `${group} `;
  if (!label.startsWith(prefix)) return label;
  const rest = label.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function DeviceSlider(props: {
  readonly definition: ParameterDefinition;
  /** The name shown, when shorter than the parameter's own. */
  readonly label: string;
  readonly value: number;
  /** Shown but set elsewhere (a synced delay's Time), so not adjustable. */
  readonly derived: boolean;
  readonly inputId: string;
  readonly control: ControlAddress;
  command(value: number): RawCommandInput;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}): JSX.Element {
  const control = createControlGesture({
    beginGesture: (options) => props.beginGesture(options),
    dispatch: (commands) => props.dispatch(commands),
    summary: () => `Set ${props.definition.label}`,
    command: (next) => props.command(next),
  });
  return (
    <div class="device-control">
      <FillSlider
        definition={props.definition}
        // A derived value can lie outside the slider's own range (a synced
        // 1/2 at a slow tempo); the fill stops at the end, the reading does not.
        value={clampParameterValue(props.definition, props.value)}
        inputId={props.inputId}
        control={props.control}
        label={props.label}
        ariaLabel={
          props.label === props.definition.label ? undefined : props.definition.label
        }
        displayValue={formatReadout(props.definition, props.value)}
        disabled={props.derived}
        onInput={(next) => control.input(next)}
        onCommit={(next, settle) => control.commit(next, settle)}
      />
    </div>
  );
}
