import { EQ_BANDS } from "../../domain/devices";
import type { ParameterDefinition } from "../../domain/parameters";
import { bareParameterId } from "../../domain/parameters";

/**
 * How a device's controls are grouped on its card (#447): Juno-style banks
 * under a title, in signal order, so a card reads left to right the way the
 * sound moves through it. Parameters are named by their bare id.
 */
const DEVICE_GROUPS: Readonly<
  Record<string, readonly (readonly [string, readonly string[]])[]>
> = {
  filter: [
    ["Mode", ["mode"]],
    ["Filter", ["cutoff", "resonance"]],
    ["Mix", ["wet"]],
  ],
  overdrive: [
    ["Drive", ["drive", "tone"]],
    ["Mix", ["wet", "output"]],
  ],
  saturator: [
    ["Saturation", ["drive", "character"]],
    ["Mix", ["wet", "output"]],
  ],
  compressor: [
    ["Dynamics", ["threshold", "ratio"]],
    ["Timing", ["attack", "release"]],
    ["Gain", ["makeup", "wet"]],
  ],
  delay: [
    ["Clock", ["sync"]],
    ["Division", ["division"]],
    ["Echo", ["time", "feedback"]],
    ["Colour", ["filter", "spread"]],
    ["Mix", ["wet", "output"]],
  ],
  reverb: [
    ["Space", ["size", "decay", "predelay"]],
    ["Colour", ["filter"]],
    ["Mix", ["wet", "output"]],
  ],
  // Signal order: how hard it is pushed, where it stops, how it lets go.
  limiter: [
    ["Limit", ["drive", "ceiling"]],
    ["Timing", ["release"]],
  ],
  // Per band, low to high: its switch, then where and how much. The switch
  // stands in a bank of its own, as every mode does, so the faders beside it
  // keep their pitch; the EQ's faceplate shows one band's banks at a time.
  eq: [
    ...EQ_BANDS.flatMap((band) => [
      ["Band", [`${band.id}On`]] as const,
      [band.label, [`${band.id}Freq`, `${band.id}Gain`, `${band.id}Q`]] as const,
    ]),
    ["Mix", ["output"]],
  ],
};

export interface DeviceGroup {
  readonly title: string;
  readonly parameters: readonly ParameterDefinition[];
}

/**
 * `definitions` in their card groups. A parameter no group names — a device
 * type added later — lands in a trailing "More" group, so it is never left
 * without a control.
 */
export function deviceGroups(
  type: string,
  definitions: readonly ParameterDefinition[],
): DeviceGroup[] {
  const byId = new Map(definitions.map((d) => [bareParameterId(d.id), d]));
  const groups: DeviceGroup[] = [];
  for (const [title, ids] of DEVICE_GROUPS[type] ?? []) {
    const parameters = ids.flatMap((id) => {
      const definition = byId.get(id);
      byId.delete(id);
      return definition ? [definition] : [];
    });
    if (parameters.length > 0) groups.push({ title, parameters });
  }
  if (byId.size > 0) groups.push({ title: "More", parameters: [...byId.values()] });
  return groups;
}
