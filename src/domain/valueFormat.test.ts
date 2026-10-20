import { describe, expect, it } from "vitest";
import "./devices";
import {
  clampParameterValue,
  type ParameterDefinition,
  parameterDefinitions,
  SAMPLER_PITCH,
  SAMPLER_SAMPLE_START,
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_SUSTAIN,
  SYNTH_FILTER_CUTOFF,
  SYNTH_WAVEFORM,
} from "./parameters";
import { formatReadout, formatSummary } from "./valueFormat";

/**
 * Characterisation of the two parameter value formatters (GRV-179). The
 * snapshot was pinned against the per-surface formatters they replaced
 * (`formatInstrumentValue`, `formatDeviceValue`, `formatPadValue` and
 * `formatParameterValue`), so unifying them provably changed no visible string.
 *
 * For every registered definition the snapshot holds the readout a control
 * shows and the summary a history line shows, at the range's min, default and
 * max, a few points between, and the special cases (level, pan, ratio).
 */

/** The ids whose readout is a special case: level, pan and ratio. */
const SPECIAL_CASE_IDS = ["track.volume", "track.pan", "compressor.ratio"];

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

function definitionsInOrder(): ParameterDefinition[] {
  return [...parameterDefinitions().values()].sort((a, b) => a.id.localeCompare(b.id));
}

describe("parameter value formatting", () => {
  it("covers every registered definition", () => {
    const ids = definitionsInOrder().map((definition) => definition.id);
    for (const id of [...SPECIAL_CASE_IDS, ...Object.keys(SPECIAL_VALUES)]) {
      expect(ids).toContain(id);
    }
  });

  it("reads every definition the same way it always has", () => {
    const lines = definitionsInOrder().flatMap((definition) =>
      sampleValues(definition).map(
        (value) =>
          `${definition.id} ${value} | readout ${formatReadout(definition, value)} | summary ${formatSummary(definition, value)}`,
      ),
    );
    expect(lines.join("\n")).toMatchSnapshot();
  });
});

describe("formatReadout", () => {
  it("names the waveform", () => {
    expect(formatReadout(SYNTH_WAVEFORM, 0)).toBe("Sine");
    expect(formatReadout(SYNTH_WAVEFORM, 2)).toBe("Sawtooth");
  });

  it("switches to kHz above 1000 Hz", () => {
    expect(formatReadout(SYNTH_FILTER_CUTOFF, 760)).toBe("760 Hz");
    expect(formatReadout(SYNTH_FILTER_CUTOFF, 8400)).toBe("8.4 kHz");
  });

  it("reads short times in milliseconds", () => {
    expect(formatReadout(SYNTH_AMP_ATTACK, 0.006)).toBe("6 ms");
  });

  it("signs semitone pitch", () => {
    expect(formatReadout(SAMPLER_PITCH, 7)).toBe("+7 st");
    expect(formatReadout(SAMPLER_PITCH, -3)).toBe("-3 st");
    expect(formatReadout(SAMPLER_PITCH, 0)).toBe("0 st");
  });

  it("reads unit-range normalized values as a percent", () => {
    expect(formatReadout(SAMPLER_SAMPLE_START, 0.25)).toBe("25%");
    expect(formatReadout(SYNTH_AMP_SUSTAIN, 0.6)).toBe("60%");
  });
});
