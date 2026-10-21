import { Match, Switch } from "@solidjs/web";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type { Instrument } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import SamplerPanel from "../../instrument/SamplerPanel";
import type { WatchPeaks } from "../../instrument/SampleWell";
import SynthPanel from "../../instrument/SynthPanel";

export interface InstrumentPanelProps {
  readonly trackId: TrackId;
  readonly instrument: Instrument | null;
  /** Display name of the currently loaded sample, or null when empty. */
  readonly sampleName: string | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Opens the one history gesture a slider drag commits as (#254). */
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Opens the library on the sampler's sample slot (`UI-001`). */
  readonly onBrowse?: () => void;
  /** Follows a sound's decoded waveform for the sampler's well (#447). */
  readonly watchPeaks?: WatchPeaks;
}

/**
 * The sampler/synth instrument panel switch. The drum machine's panel is
 * mounted separately by `EditorView` (it does not share this track-editor
 * seam); an instrument of any other kind renders nothing.
 *
 * Split out of `EditorView` (`REFACTOR-001`) to encapsulate the `Extract<>`
 * narrowing this switch needs — `instrument` is a discriminated union and
 * `Show`'s `when` alone can't narrow it, so each branch re-asserts its own
 * variant.
 */
export default function InstrumentPanel(props: InstrumentPanelProps) {
  return (
    <Switch>
      <Match
        when={
          props.instrument?.kind === "sampler" &&
          (props.instrument as Extract<Instrument, { kind: "sampler" }>)
        }
      >
        {(sampler) => (
          <SamplerPanel
            trackId={props.trackId}
            instrument={sampler()}
            sampleName={props.sampleName}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
            onBrowse={props.onBrowse}
            watchPeaks={props.watchPeaks}
          />
        )}
      </Match>
      <Match
        when={
          props.instrument?.kind === "synth" &&
          (props.instrument as Extract<Instrument, { kind: "synth" }>)
        }
      >
        {(synth) => (
          <SynthPanel
            trackId={props.trackId}
            instrument={synth()}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
          />
        )}
      </Match>
    </Switch>
  );
}
