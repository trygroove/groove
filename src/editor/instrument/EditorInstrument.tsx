import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { analytics } from "../../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import type {
  Asset,
  Clip,
  Instrument,
  NoteTrigger,
  Project,
  ReturnBus,
  Track,
} from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import InstrumentKindPicker from "../../instrument/InstrumentKindPicker";
import type { WatchPeaks } from "../../instrument/SampleWell";
import type { LibrarySample } from "../../library/assetDrag";
import DeviceChainPanel from "../devices/DeviceChainPanel";
import LevelMeter from "../mixer/LevelMeter";
import ReturnPanel from "../mixer/ReturnPanel";
import DrumMachinePanel from "../sequence/DrumMachinePanel";
import TrackInstrument from "../tracks/TrackInstrument";
import TrackRail from "../tracks/TrackRail";
import { deleteTrack, moveTrack } from "../tracks/trackActions";
import type { NewTrackKindSpec } from "../tracks/trackCreation";
import type { TrackLevel } from "../tracks/trackLevels";
import type { TrackSelectionSource } from "../tracks/trackSurface";
import LoopPanel from "../transport/LoopPanel";
import InstrumentHeader from "./InstrumentHeader";
import { instrumentHeaderFacts } from "./instrumentHeader";
import "./EditorInstrument.css";

export interface EditorInstrumentProps {
  readonly project: Project;
  /** The selected track, or null while the project has none. */
  readonly track: Track | null;
  /**
   * The return selected in the mixer (#386), when one is: the view is then in
   * return mode, showing that return's chain in place of a track's sound.
   */
  readonly returnBus?: ReturnBus | null;
  /** That track when it carries a drum machine, which gets its own pad grid. */
  readonly drumTrack: Track | null;
  readonly sampleAssets: readonly Asset[];
  readonly instrument: Instrument | null;
  readonly instrumentTrackId: TrackId | null;
  readonly sampleName: string | null;
  readonly loadSample: (sample: LibrarySample) => void;
  readonly audition: () => void;
  readonly auditionPad: (trackId: TrackId, padId: PadId) => void;
  /** Opens the library on the sampler's sample slot (`UI-001`). */
  readonly onBrowse: () => void;
  /** Opens the library on one drum pad's sample slot (#447). */
  readonly onBrowsePad?: (trackId: TrackId, padId: PadId) => void;
  /** Opens the library on loops, for a loop track's loop slot. */
  readonly onBrowseLoop?: (trackId: TrackId) => void;
  /** A track's live level, reactively, for the header's meter (#447). */
  trackLevel?(trackId: TrackId): TrackLevel | null;
  /** Follows one track's instrument triggers as they are heard (#447). */
  readonly watchTriggers?: (
    trackId: TrackId,
    onTrigger: (trigger: NoteTrigger) => void,
  ) => () => void;
  /** Follows a sound's decoded waveform for the sampler's well (#447). */
  readonly watchPeaks?: WatchPeaks;
  /** Points the editor at a track, saying how (#960): see `TrackSelectionSource`. */
  onSelectTrack(trackId: TrackId, how: TrackSelectionSource): void;
  /** The track the user chose on its header (#960), framed in the rail. */
  readonly chosenTrackId?: TrackId | null;
  /**
   * The drum pad selected on the shown track, when the host owns it (#643):
   * the step grid's selected row is the same selection, so it outlives a
   * switch of view. Held here when omitted.
   */
  readonly selectedPadId?: PadId | null;
  onSelectPad?(trackId: TrackId, padId: PadId): void;
  /** Adds a track of the chosen kind, from the rail's add buttons (#495). */
  onAddTrack?(spec: NewTrackKindSpec): void;
  /** Opens the library on loops, for the rail's Loop button. */
  onAddLoop?(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/** A track's tempo-labelled loop and the asset it plays, when it has one. */
function trackLoop(
  project: Project,
  track: Track,
): { clip: Clip | null; asset: Asset | null } {
  const clip =
    project.clips.find(
      (candidate) =>
        candidate.trackId === track.id && candidate.content.kind === "audioLoop",
    ) ?? null;
  const assetId = clip?.content.kind === "audioLoop" ? clip.content.assetId : null;
  const asset = project.song.assets.find((candidate) => candidate.id === assetId) ?? null;
  return { clip, asset };
}

/**
 * The Instrument view (`UI-001`): one track's sound, and nothing else.
 *
 * One job at a time is the whole bet — the timeline is not merely hidden behind
 * this, it is not on the page — so the instrument gets the room a panel wedged
 * under the arrangement never had. The rail down the left edge is how you move
 * between tracks here, since the arrangement's headers and the mixer's strips
 * are both on other pages now.
 *
 * The selected track's device chain sits beneath the instrument (#241), in the
 * slot UI-001 reserved for it. It reads the same selected track as everything
 * else here, so the rail, the mixer and the arrangement all move it; there is
 * no second selection. The master's chain is #283's, in the mixer.
 *
 * A return selected in the mixer puts the view in return mode (#386): the rail
 * marks no track, and the body is that return's chain with no instrument.
 * Selecting a track anywhere leaves it.
 */
export default function EditorInstrument(props: EditorInstrumentProps): JSX.Element {
  // The drum pad the pad editor shows, lifted here so the header can name it
  // and audition it (#447), and to the host when it shares it with the step
  // grid (#643). A pad the track lacks reads as its first.
  const [ownPad, setOwnPad] = createSignal<PadId | null>(null);
  const selectedPad = () =>
    props.selectedPadId !== undefined ? props.selectedPadId : ownPad();
  const setSelectedPad = (trackId: TrackId, padId: PadId) => {
    setOwnPad(padId);
    props.onSelectPad?.(trackId, padId);
  };

  /** The header's Audition: the selected pad on a drum machine, else the instrument. */
  function audition(track: Track) {
    if (track.type === "audio" || !track.instrument) return undefined;
    const instrument = track.instrument;
    if (instrument.kind !== "drumMachine") {
      return { label: "Audition", run: () => props.audition() };
    }
    return {
      label: "Audition pad",
      run: () => {
        const pad =
          instrument.pads.find((candidate) => candidate.id === selectedPad()) ??
          instrument.pads[0];
        if (pad) props.auditionPad(track.id, pad.id);
      },
    };
  }

  /**
   * The header row every instrument unit opens with (#447), built once for the
   * track on screen: its props follow the track, so an edit updates the row in
   * place rather than rebuilding it, and its meter, on every change.
   */
  const header = (track: () => Track) => (
    <InstrumentHeader
      facts={instrumentHeaderFacts(props.project, track(), selectedPad())}
      trackName={track().name}
      audition={audition(track())}
      meter={
        props.trackLevel ? (
          <LevelMeter
            level={() => props.trackLevel?.(track().id) ?? null}
            orientation="horizontal"
          />
        ) : undefined
      }
    />
  );

  return (
    <div class="instrument-view">
      <TrackRail
        tracks={props.project.song.tracks}
        selectedTrackId={props.returnBus ? null : (props.track?.id ?? null)}
        chosenTrackId={props.returnBus ? null : props.chosenTrackId}
        onSelect={(trackId) => props.onSelectTrack(trackId, "header")}
        onAddTrack={props.onAddTrack}
        onAddLoop={props.onAddLoop}
        dispatch={props.dispatch}
        beginGesture={props.beginGesture}
        trackLevel={props.trackLevel}
        analytics={analytics}
        onDelete={(trackId) =>
          deleteTrack(
            {
              project: () => props.project,
              dispatch: props.dispatch,
              select: (trackId) => props.onSelectTrack(trackId, "follow"),
              analytics,
            },
            trackId,
          )
        }
        onReorder={(trackId, toIndex) =>
          moveTrack(
            { project: () => props.project, dispatch: props.dispatch, analytics },
            trackId,
            toIndex,
            { view: "instrument", method: "drag" },
          )
        }
      />
      <div class="instrument-view-body">
        <Show
          when={!props.returnBus}
          fallback={
            <Show when={props.returnBus}>
              {(returnBus) => (
                <ReturnPanel
                  project={props.project}
                  returnBus={returnBus()}
                  dispatch={props.dispatch}
                  beginGesture={props.beginGesture}
                />
              )}
            </Show>
          }
        >
          <Show
            when={props.track}
            fallback={
              <p class="no-track">
                This project has no tracks yet. Add one in the mixer.
              </p>
            }
          >
            {(currentTrack) => {
              const unitHeader = header(currentTrack);
              const loop = createMemo(() => trackLoop(props.project, currentTrack()));
              return (
                // The track's own colour is the ink its wells draw in (#447).
                <div
                  class="instrument-view-track"
                  style={{ "--track-ink": currentTrack().color }}
                >
                  {/* The kind picker heads the view, outside the instrument it
                  chooses (#447). A loop track shows it too, with nothing to
                  choose yet: a loop is not one of the kinds. */}
                  <InstrumentKindPicker
                    trackId={currentTrack().id}
                    project={props.project}
                    instrument={currentTrack().type === "audio" ? null : props.instrument}
                    dispatch={props.dispatch}
                    disabled={currentTrack().type === "audio"}
                  />
                  {/* An audio track plays a loop, so it shows the loop's faceplate
                  (#447). Either way the header row is the unit's first row. */}
                  <Show
                    when={currentTrack().type === "audio"}
                    fallback={
                      <TrackInstrument
                        trackName={currentTrack().name}
                        instrument={props.instrument}
                        trackId={props.instrumentTrackId}
                        sampleName={props.sampleName}
                        loadSample={props.loadSample}
                        onBrowse={props.onBrowse}
                        watchPeaks={props.watchPeaks}
                        dispatch={props.dispatch}
                        beginGesture={props.beginGesture}
                        header={unitHeader}
                      >
                        <Show when={props.drumTrack}>
                          {(drum) => (
                            <div class="drum-machine-editor">
                              <DrumMachinePanel
                                track={drum()}
                                assets={props.sampleAssets}
                                dispatch={props.dispatch}
                                beginGesture={props.beginGesture}
                                audition={(padId) => props.auditionPad(drum().id, padId)}
                                selectedPadId={selectedPad()}
                                onSelectPad={(padId) => setSelectedPad(drum().id, padId)}
                                onBrowseSample={(padId) =>
                                  props.onBrowsePad?.(drum().id, padId)
                                }
                                watchPeaks={props.watchPeaks}
                                watchTriggers={props.watchTriggers}
                              />
                            </div>
                          )}
                        </Show>
                      </TrackInstrument>
                    }
                  >
                    <LoopPanel
                      trackName={currentTrack().name}
                      clip={loop().clip}
                      asset={loop().asset}
                      songTempo={props.project.song.tempo}
                      watchPeaks={props.watchPeaks}
                      header={unitHeader}
                      onBrowse={
                        props.onBrowseLoop
                          ? () => props.onBrowseLoop?.(currentTrack().id)
                          : undefined
                      }
                    />
                  </Show>
                  <DeviceChainPanel
                    track={currentTrack()}
                    tempo={props.project.song.tempo}
                    dispatch={props.dispatch}
                    beginGesture={props.beginGesture}
                  />
                </div>
              );
            }}
          </Show>
        </Show>
      </div>
    </div>
  );
}
