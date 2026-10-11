import { For, type JSX, Show } from "@solidjs/web";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import { createControlGesture, setParameter } from "../commands";
import {
  CONTROL_PARTS,
  controlAddress,
  parameterControl,
} from "../commands/controlAddress";
import type { Instrument } from "../domain/entities";
import type { TrackId } from "../domain/ids";
import {
  bareParameterId,
  type ParameterDefinition,
  readInstrumentParameter,
  SAMPLER_AMP_ATTACK,
  SAMPLER_AMP_DECAY,
  SAMPLER_AMP_RELEASE,
  SAMPLER_AMP_SUSTAIN,
  SAMPLER_PITCH,
  SAMPLER_SAMPLE_END,
  SAMPLER_SAMPLE_START,
} from "../domain/parameters";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import ControlGroup from "./ControlGroup";
import EnvelopeWell from "./EnvelopeWell";
import FillSlider from "./FillSlider";
import { formatInstrumentValue } from "./formatValue";
import "./InstrumentPanel.css";
import SampleSlot from "./SampleSlot";
import SampleWell, { type WatchPeaks } from "./SampleWell";

export interface SamplerPanelProps {
  readonly trackId: TrackId;
  readonly instrument: Extract<Instrument, { kind: "sampler" }>;
  /** Display name of the currently loaded sample, or null when empty. */
  readonly sampleName: string | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Opens the library on this slot (`UI-001`). Absent where nothing can. */
  readonly onBrowse?: () => void;
  /** Follows the loaded sound's waveform for its well (#447). */
  readonly watchPeaks?: WatchPeaks;
  readonly analytics?: Analytics;
}

const PLAYBACK_SLIDERS = [SAMPLER_PITCH, SAMPLER_SAMPLE_START, SAMPLER_SAMPLE_END];

const ENVELOPE_SLIDERS = [
  SAMPLER_AMP_ATTACK,
  SAMPLER_AMP_DECAY,
  SAMPLER_AMP_SUSTAIN,
  SAMPLER_AMP_RELEASE,
];

/**
 * The reusable one-shot sampler panel (PRD INS-01), in the faceplate's columns
 * (#447): the loaded sound's waveform over its name and the Playback faders
 * (pitch, start, end), and the amp envelope over its ADSR faders. The start and
 * end markers and the envelope's corners can be dragged on their wells; the
 * faders and value fields set the same parameters from the keyboard.
 *
 * A sound is chosen by dragging it here from the library (#225), which is why
 * the panel names the loaded sample rather than offering a list to swap
 * between: that list could only ever offer sounds the project already carried,
 * which for a new project is the one it started with. The drop itself belongs
 * to the surrounding `InstrumentArea`, named for its track so a drop lands on a
 * particular one; this panel stays a panel.
 *
 * Parameter edits dispatch a validated `parameter.set` in the `instrument`
 * scope. A continuous slider runs the whole drag as one history gesture
 * (`createControlGesture`): every move applies live, so the fill, the readout
 * and the audio follow the pointer, and the release commits the lot as one
 * entry, one revision and one analytics event (#254).
 */
export default function SamplerPanel(props: SamplerPanelProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;

  function parameterCommand(parameterId: string, value: number) {
    return setParameter(
      { scope: "instrument", trackId: props.trackId, parameterId },
      value,
    );
  }

  const read = (definition: ParameterDefinition) =>
    readInstrumentParameter(definition, props.instrument.parameters);
  /** A well's drag writes the same `parameter.set` a fader does. */
  const wellEdits = {
    dispatch: props.dispatch,
    beginGesture: props.beginGesture,
    onCommit: () => analytics().logFeatureFirstUse("sampler"),
  };
  const command = (definition: ParameterDefinition, value: number) =>
    parameterCommand(bareParameterId(definition.id), value);

  return (
    <section class="instrument-panel sampler-panel" aria-label="Sampler">
      <div class="faceplate-grid">
        <div class="faceplate-column span-7">
          <SampleWell
            assetId={props.instrument.assetId}
            watchPeaks={props.watchPeaks}
            start={read(SAMPLER_SAMPLE_START)}
            end={read(SAMPLER_SAMPLE_END)}
            readout={`${formatInstrumentValue(SAMPLER_SAMPLE_START, read(SAMPLER_SAMPLE_START))} → ${formatInstrumentValue(SAMPLER_SAMPLE_END, read(SAMPLER_SAMPLE_END))}`}
            commandStart={(value) => command(SAMPLER_SAMPLE_START, value)}
            commandEnd={(value) => command(SAMPLER_SAMPLE_END, value)}
            {...wellEdits}
          />
          <div class="sampler-under-sample">
            <div class="instrument-panel-group sampler-sample-group">
              <div class="control-group-head">
                <h3 class="control-group-title">Sample</h3>
              </div>
              {/* The slot is the way into the library (UI-001): it names what is
                  loaded, and opening it is how that changes. */}
              <Show
                when={props.onBrowse}
                fallback={
                  <p class={`sampler-sample-name ${MASK_CONTENT}`}>
                    {props.sampleName ?? "No sample loaded"}
                  </p>
                }
              >
                {(browse) => (
                  <SampleSlot
                    label="Sample"
                    slot={{ kind: "sampler" }}
                    control={controlAddress(props.trackId, CONTROL_PARTS.sample)}
                    name={props.sampleName}
                    onBrowse={browse()}
                  />
                )}
              </Show>
            </div>
            <ControlGroup title="Playback" class="instrument-panel-group">
              <For each={PLAYBACK_SLIDERS}>{(definition) => sliderFor(definition)}</For>
            </ControlGroup>
          </div>
        </div>
        <div class="faceplate-column span-5">
          <EnvelopeWell
            definitions={{
              attack: SAMPLER_AMP_ATTACK,
              decay: SAMPLER_AMP_DECAY,
              sustain: SAMPLER_AMP_SUSTAIN,
              release: SAMPLER_AMP_RELEASE,
            }}
            times={{
              attack: read(SAMPLER_AMP_ATTACK),
              decay: read(SAMPLER_AMP_DECAY),
              sustain: read(SAMPLER_AMP_SUSTAIN),
              release: read(SAMPLER_AMP_RELEASE),
            }}
            command={command}
            {...wellEdits}
          />
          <ControlGroup title="Amp envelope" class="instrument-panel-group">
            <For each={ENVELOPE_SLIDERS}>{(definition) => sliderFor(definition)}</For>
          </ControlGroup>
        </div>
      </div>
    </section>
  );

  function sliderFor(definition: (typeof PLAYBACK_SLIDERS)[number]): JSX.Element {
    const value = () => readInstrumentParameter(definition, props.instrument.parameters);
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
        value={value()}
        displayValue={formatInstrumentValue(definition, value())}
        onInput={(next) => control.input(next)}
        onCommit={(next, settle) => {
          control.commit(next, settle);
          analytics().logFeatureFirstUse("sampler");
        }}
      />
    );
  }
}
