import { formatDb, formatPan } from "./faders";
import {
  bareParameterId,
  type ParameterDefinition,
  SYNTH_WAVEFORM,
  synthWaveform,
  TRACK_PAN,
  TRACK_VOLUME,
} from "./parameters";

/**
 * The two ways a parameter value is written as text (GRV-179). Every surface
 * that shows a value asks one of these, keyed on the parameter's definition;
 * the fader primitives `formatDb` and `formatPan` in `faders.ts` are what both
 * fall back on for a level or a pan.
 *
 * - **`formatReadout`** is for *reading a control*: the live value under a
 *   slider, a knob's label, a faceplate or header readout. It speaks the way a
 *   musician reads the control, so it changes unit with the value ("250 ms",
 *   "1.2 s"; "760 Hz", "8.4 kHz"), names a choice ("Sawtooth"), signs a pitch
 *   ("+7 st") and prints a compressor ratio as "4.0:1".
 * - **`formatSummary`** is for *a history line*: the command summary behind an
 *   undo label, the history list and a proposal row. It is the stored number,
 *   rounded to four places, with the unit's word ("0.25 s", "7 semitones",
 *   "120 BPM"), so the same edit always reads the same way whatever range it
 *   lands in.
 *
 * They differ on purpose, and tests and QA assert both, so merging them would
 * change visible strings. A caller showing a control wants `formatReadout`; a
 * caller describing an edit wants `formatSummary`.
 */

/** A value in its own unit, as the control that sets it reads it. */
export function formatReadout(definition: ParameterDefinition, value: number): string {
  // A pad's level and pan sit on its mixer, and read like a channel strip's.
  if (definition.id === TRACK_VOLUME.id) return formatDb(definition, value);
  if (definition.id === TRACK_PAN.id) return formatPan(value);
  // The one device quantity whose unit is a relationship: "4.0:1", as every
  // compressor prints it.
  if (bareParameterId(definition.id) === "ratio") return `${value.toFixed(1)}:1`;
  if (definition.id === SYNTH_WAVEFORM.id) return capitalize(synthWaveform(value));
  switch (definition.unit) {
    case "hertz":
      return value >= 1000 ? `${trim(value / 1000, 1)} kHz` : `${Math.round(value)} Hz`;
    case "seconds":
      return value < 1 ? `${Math.round(value * 1000)} ms` : `${trim(value, 2)} s`;
    case "semitones": {
      const rounded = Math.round(value);
      return `${rounded > 0 ? "+" : ""}${rounded} st`;
    }
    case "decibels":
      return `${trim(value, 1)} dB`;
    case "normalized":
      // Sustain and resonance are dimensionless; start/end read as a percent.
      return definition.max <= 1 ? `${Math.round(value * 100)}%` : trim(value, 2);
    default:
      return trim(value, 2);
  }
}

const UNIT_SUFFIX: Record<ParameterDefinition["unit"], string> = {
  bars: " bars",
  bpm: " BPM",
  decibels: " dB",
  hertz: " Hz",
  percent: "%",
  seconds: " s",
  semitones: " semitones",
  normalized: "",
  bipolar: "",
};

/** A value for a summary line: the stored number and its unit's word. */
export function formatSummary(definition: ParameterDefinition, value: number): string {
  return `${Number(value.toFixed(4))}${UNIT_SUFFIX[definition.unit]}`;
}

function trim(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
