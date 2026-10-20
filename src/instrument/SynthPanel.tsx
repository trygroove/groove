import { For, type JSX } from "@solidjs/web";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import { createControlGesture, setParameter } from "../commands";
import { parameterControl } from "../commands/controlAddress";
import type { Instrument } from "../domain/entities";
import type { TrackId } from "../domain/ids";
import {
  bareParameterId,
  type ParameterDefinition,
  readInstrumentParameter,
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_DECAY,
  SYNTH_AMP_RELEASE,
  SYNTH_AMP_SUSTAIN,
  SYNTH_FILTER_CUTOFF,
  SYNTH_FILTER_RESONANCE,
  SYNTH_WAVEFORM,
  SYNTH_WAVEFORMS,
  synthWaveform,
} from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import ControlGroup from "./ControlGroup";
import EnvelopeWell from "./EnvelopeWell";
import FillSlider from "./FillSlider";
import FilterWell from "./FilterWell";
import "./InstrumentPanel.css";
import OptionGroup from "./OptionGroup";
import OscillatorWell from "./OscillatorWell";
import { WaveformIcon } from "./waveformIcons";

export interface SynthPanelProps {
  readonly trackId: TrackId;
  readonly instrument: Extract<Instrument, { kind: "synth" }>;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Plays one preview note through the track. */
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
}

const FILTER_SLIDERS = [SYNTH_FILTER_CUTOFF, SYNTH_FILTER_RESONANCE];
const ENVELOPE_SLIDERS = [
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_DECAY,
  SYNTH_AMP_SUSTAIN,
  SYNTH_AMP_RELEASE,
];

/**
 * The reusable synth voice panel (PRD INS-01), laid out in the faceplate's
 * columns (#447): each section is a well that draws what it does over the
 * group of controls that set it — the oscillator over its waveform switch, the
 * low-pass response over cutoff and resonance, the amp envelope over ADSR. The
 * filter point and the envelope's corners can be dragged on the wells; the
 * faders and their value fields set the same parameters from the keyboard.
 *
 * Every control dispatches a validated `parameter.set` command in the
 * `instrument` scope — never a direct project mutation — so edits are
 * revision-checked and undoable, and the audio graph reuses its nodes with
 * smoothing. A continuous slider runs the whole drag as one history gesture
 * (`createControlGesture`): every move applies live, so the fill, the readout
 * and the filter follow the pointer, and the release (or blur) commits the lot
 * as one history entry, one revision and one analytics event (#254).
 * `feature_first_use` for `synth` fires once, on the first edit, not per render.
 */
export default function SynthPanel(props: SynthPanelProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;

  function parameterCommand(parameterId: string, value: number) {
    return setParameter(
      { scope: "instrument", trackId: props.trackId, parameterId },
      value,
    );
  }

  /** A discrete choice: one command, no gesture to hold open. */
  function commit(parameterId: string, value: number): void {
    props.dispatch(parameterCommand(parameterId, value));
    analytics().logFeatureFirstUse("synth");
  }

  const currentWaveform = () =>
    synthWaveform(readInstrumentParameter(SYNTH_WAVEFORM, props.instrument.parameters));
  const read = (definition: ParameterDefinition) =>
    readInstrumentParameter(definition, props.instrument.parameters);

  /** A well's drag writes the same `parameter.set` a fader does. */
  const wellCommand = (definition: ParameterDefinition, value: number) =>
    parameterCommand(bareParameterId(definition.id), value);
  const wellEdits = {
    command: wellCommand,
    dispatch: props.dispatch,
    beginGesture: props.beginGesture,
    onCommit: () => analytics().logFeatureFirstUse("synth"),
  };

  function slider(definition: ParameterDefinition): JSX.Element {
    const control = createControlGesture({
      beginGesture: (options) => props.beginGesture(options),
      dispatch: (commands) => props.dispatch(commands),
      summary: () => `Set ${definition.label}`,
      command: (next) => parameterCommand(bareParameterId(definition.id), next),
    });
    return (
      <FillSlider
        definition={definition}
        control={parameterControl(props.trackId, definition.id)}
        value={read(definition)}
        displayValue={formatReadout(definition, read(definition))}
        onInput={(next) => control.input(next)}
        onCommit={(next, settle) => {
          control.commit(next, settle);
          analytics().logFeatureFirstUse("synth");
        }}
      />
    );
  }

  return (
    <section class="instrument-panel synth-panel" aria-label="Synth voice">
      <div class="faceplate-grid">
        <div class="faceplate-column span-3">
          <OscillatorWell
            waveform={currentWaveform()}
            label={capitalize(currentWaveform())}
          />
          <ControlGroup title="Waveform">
            <OptionGroup
              legend="Waveform"
              control={parameterControl(props.trackId, SYNTH_WAVEFORM.id)}
              fill
              value={currentWaveform()}
              options={SYNTH_WAVEFORMS.map((waveform) => ({
                value: waveform,
                label: capitalize(waveform),
                icon: <WaveformIcon waveform={waveform} />,
              }))}
              onSelect={(waveform) =>
                commit(
                  bareParameterId(SYNTH_WAVEFORM.id),
                  SYNTH_WAVEFORMS.indexOf(waveform),
                )
              }
            />
          </ControlGroup>
        </div>
        <div class="faceplate-column span-4">
          <FilterWell
            shape="lowpass"
            cutoff={SYNTH_FILTER_CUTOFF}
            resonance={SYNTH_FILTER_RESONANCE}
            values={{
              cutoff: read(SYNTH_FILTER_CUTOFF),
              resonance: read(SYNTH_FILTER_RESONANCE),
            }}
            readout={`${formatReadout(SYNTH_FILTER_CUTOFF, read(SYNTH_FILTER_CUTOFF))} · Q ${formatReadout(SYNTH_FILTER_RESONANCE, read(SYNTH_FILTER_RESONANCE))}`}
            {...wellEdits}
          />
          <ControlGroup title="Low-pass filter">
            <For each={FILTER_SLIDERS}>{(definition) => slider(definition)}</For>
          </ControlGroup>
        </div>
        <div class="faceplate-column span-5">
          <EnvelopeWell
            definitions={{
              attack: SYNTH_AMP_ATTACK,
              decay: SYNTH_AMP_DECAY,
              sustain: SYNTH_AMP_SUSTAIN,
              release: SYNTH_AMP_RELEASE,
            }}
            times={{
              attack: read(SYNTH_AMP_ATTACK),
              decay: read(SYNTH_AMP_DECAY),
              sustain: read(SYNTH_AMP_SUSTAIN),
              release: read(SYNTH_AMP_RELEASE),
            }}
            {...wellEdits}
          />
          <ControlGroup title="Amp envelope">
            <For each={ENVELOPE_SLIDERS}>{(definition) => slider(definition)}</For>
          </ControlGroup>
        </div>
      </div>
    </section>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
