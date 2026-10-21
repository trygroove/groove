import type { DeviceChainTarget, ParameterTarget } from "../../commands";
import { isModeParameter, parameterChoiceLabel } from "../../commands/parameterChoices";
import { delayDivision, deviceParameters } from "../../domain/devices";
import type { Device } from "../../domain/entities";
import type { DeviceId } from "../../domain/ids";
import { bareParameterId, type ParameterDefinition } from "../../domain/parameters";
import { delayTime } from "./deviceDrawings";

/**
 * How one device parameter is shown (PRD FX-01: a device's own controls,
 * never a preset picker).
 *
 * The control is derived from the parameter's definition in
 * `src/domain/devices.ts`, not written per device: a continuous value is a
 * fill-slider, and a stepped mode — a filter's type, a delay's sync and note
 * division — is a named option group, because "1" is not a musical answer to
 * "which filter?". The *names* of those choices live in
 * `src/commands/parameterChoices.ts`, which the undo history's summaries read
 * too; the index each one stores is its position, exactly as the audio layer
 * reads it.
 */

export interface DeviceChoice {
  readonly value: number;
  readonly label: string;
}

/**
 * The named choices for a stepped mode parameter, or `null` for a continuous
 * one. A stepped parameter nobody has named yet falls back to its numbers, so
 * a new device type is never left without a control.
 */
export function deviceChoices(definition: ParameterDefinition): DeviceChoice[] | null {
  if (!isModeParameter(definition)) return null;
  const choices: DeviceChoice[] = [];
  for (let value = definition.min; value <= definition.max; value += 1) {
    choices.push({
      value,
      label: parameterChoiceLabel(definition, value) ?? String(value),
    });
  }
  return choices;
}

/** A device's current value for one of its parameters, defaulted when unset. */
export function readDeviceParameter(
  device: Device,
  definition: ParameterDefinition,
): number {
  return device.parameters[bareParameterId(definition.id)] ?? definition.defaultValue;
}

/** What one device control shows: the value in use, and whether it is set by another. */
export interface DeviceControlReading {
  /** The value the device is actually using, in the parameter's own unit. */
  readonly value: number;
  /**
   * True when another setting decides the value, so the control shows it but
   * does not set it: a synced delay's time comes from its division and the
   * song tempo, and its stored free time is not in use (#865).
   */
  readonly derived: boolean;
}

/**
 * The value a device control shows. Usually the stored value; but a synced
 * delay's Time reads the time the division gives at `tempo`, computed by the
 * same `delayTime` the delay's well reads out, so the two never disagree.
 */
export function readDeviceControl(
  device: Device,
  definition: ParameterDefinition,
  tempo: number,
): DeviceControlReading {
  const stored = readDeviceParameter(device, definition);
  if (definition.id !== "delay.time") return { value: stored, derived: false };
  const setting = (id: string) => {
    const sibling = deviceParameters(device.type).find((d) => d.id === `delay.${id}`);
    return sibling ? readDeviceParameter(device, sibling) : 0;
  };
  if (setting("sync") < 0.5) return { value: stored, derived: false };
  const division = delayDivision(setting("division")).wholeNotes;
  return { value: delayTime(true, stored, division, tempo), derived: true };
}

/**
 * The `parameter.set` target for one parameter of a device in `chain`: a
 * track's inserts write through `trackDevice`, the master's through
 * `masterDevice`, a return bus's through `returnDevice`. The device's controls
 * are the same component in every chain; only this address differs.
 */
export function deviceParameterTarget(
  chain: DeviceChainTarget,
  deviceId: DeviceId,
  parameterId: string,
): ParameterTarget {
  switch (chain.chain) {
    case "insert":
      return { scope: "trackDevice", trackId: chain.trackId, deviceId, parameterId };
    case "master":
      return { scope: "masterDevice", deviceId, parameterId };
    case "return":
      return { scope: "returnDevice", returnId: chain.returnId, deviceId, parameterId };
  }
}
