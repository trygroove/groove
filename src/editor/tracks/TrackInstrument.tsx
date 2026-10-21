import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type { Instrument } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import type { WatchPeaks } from "../../instrument/SampleWell";
import type { LibrarySample } from "../../library/assetDrag";
import InstrumentArea from "../instrument/InstrumentArea";
import InstrumentPanel from "../instrument/InstrumentPanel";

export interface TrackInstrumentProps {
  readonly trackName: string | undefined;
  readonly instrument: Instrument | null;
  /** The edited track, when there is one; null while no project is open. */
  readonly trackId: TrackId | null;
  readonly sampleName: string | null;
  /** Loads a sound dropped from the library onto this track's sampler (#225). */
  readonly loadSample: (sample: LibrarySample) => void;
  /** Opens the library on the sampler's sample slot (`UI-001`). */
  readonly onBrowse: () => void;
  /** The instrument's header row, at the top of the unit (#447). */
  readonly header?: JSX.Element;
  /** A panel the kind switch does not draw: the drum machine's (#447). */
  readonly children?: JSX.Element;
  /** Follows a sound's decoded waveform for the sampler's well (#447). */
  readonly watchPeaks?: WatchPeaks;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * One track's instrument: its header row and whichever panel its kind gets,
 * inside a region named for the track so a sound dragged from the library lands
 * on a particular one (#225). The kind picker sits above it, outside the unit
 * (#447).
 *
 * Split out of `TrackEditor` (`UI-001`), which used to carry this *and* the
 * track's clip; every prop is the exact value it passed through, so this half
 * of the split is a pure relocation.
 */
export default function TrackInstrument(props: TrackInstrumentProps) {
  return (
    <InstrumentArea
      trackName={props.trackName ?? "Track"}
      instrument={props.instrument}
      loadSample={props.loadSample}
    >
      {props.header}
      <Show when={props.trackId}>
        {(trackId) => (
          <InstrumentPanel
            trackId={trackId()}
            instrument={props.instrument}
            sampleName={props.sampleName}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
            onBrowse={props.onBrowse}
            watchPeaks={props.watchPeaks}
          />
        )}
      </Show>
      {props.children}
    </InstrumentArea>
  );
}
