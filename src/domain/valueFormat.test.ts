import { describe, expect, it } from "vitest";
import { formatParameterValue } from "../commands/definitions/parameters";
import { formatDeviceValue } from "../editor/deviceControlModel";
import { formatPadValue } from "../editor/PadSound";
import { formatInstrumentValue } from "../instrument/formatValue";
import "./devices";
import {
  clampParameterValue,
  type ParameterDefinition,
  parameterDefinitions,
} from "./parameters";

/**
 * Characterisation of every parameter value formatter (GRV-179), pinned before
 * they were unified so the refactor provably changes no visible string.
 *
 * For every registered definition the snapshot holds the readout a control
 * shows and the summary a history line shows, at the range's min, default and
 * max, a few points between, and the special cases (level, pan, ratio).
 */

/** The ids whose readout differs between the old per-surface formatters. */
const PAD_MIXER_IDS = new Set(["track.volume", "track.pan"]);
const RATIO_IDS = new Set(["compressor.ratio"]);

/** The extra values each special case is checked at. */
const SPECIAL_VALUES: Record<string, readonly number[]> = {
  "track.volume": [-60, -59.96, -24, -6, -0.04, 0, 0.04, 3, 6],
  "track.pan": [-1, -0.5, -0.25, -0.004, 0, 0.004, 0.25, 0.5, 1],
  "compressor.ratio": [1, 1.5, 2, 4, 8.25, 20],
  "synth.filterCutoff": [760, 999.6, 1000, 8400],
  "synth.ampAttack": [0.006, 0.9996, 1, 1.255],
  "sampler.pitch": [-3, 0, 7],
  "sampler.sampleStart": [0.25, 0.333],
};

function sampleValues(definition: ParameterDefinition): number[] {
  const { min, max, defaultValue } = definition;
  const between = [0.1, 0.25, 0.5, 0.75, 0.9].map((fraction) =>
    clampParameterValue(definition, min + (max - min) * fraction),
  );
  const special = SPECIAL_VALUES[definition.id] ?? [];
  return [...new Set([min, defaultValue, max, ...between, ...special])];
}

/** The readout a control on any surface shows for this definition today. */
function readout(definition: ParameterDefinition, value: number): string {
  return PAD_MIXER_IDS.has(definition.id)
    ? formatPadValue(definition, value)
    : formatDeviceValue(definition, value);
}

function summary(definition: ParameterDefinition, value: number): string {
  return formatParameterValue(definition, value);
}

function definitionsInOrder(): ParameterDefinition[] {
  return [...parameterDefinitions().values()].sort((a, b) => a.id.localeCompare(b.id));
}

describe("parameter value formatting", () => {
  it("covers every registered definition", () => {
    const ids = definitionsInOrder().map((definition) => definition.id);
    for (const id of [...PAD_MIXER_IDS, ...RATIO_IDS, ...Object.keys(SPECIAL_VALUES)]) {
      expect(ids).toContain(id);
    }
  });

  it("reads every definition the same way it always has", () => {
    const lines = definitionsInOrder().flatMap((definition) =>
      sampleValues(definition).map(
        (value) =>
          `${definition.id} ${value} | readout ${readout(definition, value)} | summary ${summary(definition, value)}`,
      ),
    );
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("agrees with every per-surface formatter outside its special cases", () => {
    for (const definition of definitionsInOrder()) {
      for (const value of sampleValues(definition)) {
        const expected = readout(definition, value);
        if (!PAD_MIXER_IDS.has(definition.id) && !RATIO_IDS.has(definition.id)) {
          expect(formatInstrumentValue(definition, value)).toBe(expected);
        }
        if (!PAD_MIXER_IDS.has(definition.id)) {
          expect(formatDeviceValue(definition, value)).toBe(expected);
        }
        if (!RATIO_IDS.has(definition.id)) {
          expect(formatPadValue(definition, value)).toBe(expected);
        }
      }
    }
  });
});
