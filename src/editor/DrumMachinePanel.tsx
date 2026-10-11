import { For, type JSX, Show } from "@solidjs/web";
import { HiSolidPlus } from "solid-icons/hi";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../commands";
import { addPad, MAX_DRUM_PADS, setPadChoke, setPadFlag } from "../commands";
import { CONTROL_PARTS, controlAddress } from "../commands/controlAddress";
import DataTable, { type DataTableColumn } from "../components/DataTable";
import type { Asset, DrumPad, NoteTrigger, Track } from "../domain/entities";
import {
  createDrumPad,
  createFactoryContext,
  type DomainFactoryContext,
} from "../domain/factories";
import { formatDb, formatPan } from "../domain/faders";
import type { AssetId, PadId, TrackId } from "../domain/ids";
import { nextPadName } from "../domain/padNames";
import { PAD_PITCH, TRACK_PAN, TRACK_VOLUME } from "../domain/parameters";
import { formatInstrumentValue } from "../instrument/formatValue";
import SampleSlot from "../instrument/SampleSlot";
import { createPeaks, peakBars, type WatchPeaks } from "../instrument/SampleWell";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import MuteSoloToggles from "./MuteSoloToggles";
import PadControl from "./PadControl";
import PadName from "./PadName";
import PadSound from "./PadSound";
import "./DrumMachinePanel.css";
import "./NewTrackButtons.css";

/** How long a pad's name stays lit after it fires (#447). */
const PAD_FLASH_MS = 120;

/** Bars in a pad's waveform preview. */
const PREVIEW_BUCKETS = 56;

export { nextPadName };

/** Mints the IDs of pads this panel adds. A module singleton. */
const defaultFactoryContext = createFactoryContext();

/** The choke-group options a pad can join (PRD INS-01). `none` clears it. */
/** The pad table's columns; the three faders share what the fixed ones leave. */
const PAD_COLUMNS: readonly DataTableColumn[] = [
  { label: "#", width: "44px" },
  { label: "Pad", width: "96px" },
  { label: "Sample", width: "172px" },
  { label: "Preview", width: "120px" },
  { label: "Pitch" },
  { label: "Level" },
  { label: "Pan" },
  { label: "Choke", width: "92px" },
  { label: "M · S", width: "84px" },
];

const CHOKE_GROUPS = Array.from({ length: 8 }, (_, i) => i);

export interface DrumMachinePanelProps {
  readonly track: Track;
  /** The project's sample assets, offered as pad sources. */
  readonly assets: readonly Asset[];
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Opens a pad-control drag that commits as one history entry (#255). */
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The selected pad, when the host owns the selection (#447). */
  readonly selectedPadId?: PadId | null;
  onSelectPad?(padId: PadId): void;
  /**
   * Follows this track's triggers as they are heard, so a pad's name can flash
   * when it plays (#447). Returns the way to stop.
   */
  readonly watchTriggers?: (
    trackId: TrackId,
    onTrigger: (trigger: NoteTrigger) => void,
  ) => () => void;
  /** Opens the library to choose a pad's sound (#447). */
  onBrowseSample?(padId: PadId): void;
  /** Plays one pad immediately so the user hears their choice (audition). */
  audition?(padId: PadId): void;
  /** Follows each pad's sound for its waveform preview (#447). */
  readonly watchPeaks?: WatchPeaks;
  /** Defaults to the application's singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** Overrides the pad-ID factory so tests are deterministic. */
  readonly factoryContext?: DomainFactoryContext;
}

function pads(track: Track): readonly DrumPad[] {
  return track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
}

/**
 * The drum-machine instrument panel (PRD INS-01, LOOP-005): one named lane per
 * pad, each with sample selection, audition, pitch, level, pan, amp envelope,
 * mute/solo, and choke group. Every edit is a shared drum command dispatched
 * through the same command layer a keyboard shortcut or the assistant would use
 * — the panel never mutates project state directly (PRD section 9.6).
 */
export default function DrumMachinePanel(props: DrumMachinePanelProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;

  /** Marks the drum machine as reached, once per account per browser. */
  function markFeatureUse(): void {
    analytics().logFeatureFirstUse("drum_machine");
  }

  /** The project's sounds by id, once per change, for every row's lookup. */
  const assetsById = createMemo(
    () => new Map(props.assets.map((asset) => [asset.id, asset])),
  );
  const assetOf = (pad: DrumPad) =>
    pad.assetId === null ? undefined : assetsById().get(pad.assetId);
  /** The name of the sound a pad plays, or "None" while it has none. */
  const sampleName = (pad: DrumPad) => assetOf(pad)?.name ?? "None";

  function toggleFlag(pad: DrumPad, flag: "muted" | "soloed"): void {
    markFeatureUse();
    props.dispatch(setPadFlag(props.track.id, pad.id, flag, !pad.mixer[flag]));
  }

  function changeChoke(pad: DrumPad, value: number | null): void {
    markFeatureUse();
    props.dispatch(setPadChoke(props.track.id, pad.id, value));
  }

  // The pad shown in the editor above the table (#447). UI-only and
  // session-local, like any selection; a pad that goes away hands it back to
  // the first pad.
  const [ownPad, setOwnPad] = createSignal<PadId | null>(null);
  const chosenPad = () =>
    props.selectedPadId !== undefined ? props.selectedPadId : ownPad();
  const setChosenPad = (padId: PadId) => {
    setOwnPad(padId);
    props.onSelectPad?.(padId);
  };
  const selectedPad = () => {
    const all = pads(props.track);
    return all.find((pad) => pad.id === chosenPad()) ?? all[0];
  };

  const full = () => pads(props.track).length >= MAX_DRUM_PADS;

  // The pads sounding right now (#447): each hit lights its row's name for a
  // moment, as a hardware pad lights when it fires.
  const [hitPads, setHitPads] = createSignal<ReadonlySet<PadId>>(new Set());
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  function flash(padId: PadId): void {
    setHitPads((current) => new Set(current).add(padId));
    const timer = setTimeout(() => {
      flashTimers.delete(timer);
      setHitPads((current) => {
        const next = new Set(current);
        next.delete(padId);
        return next;
      });
    }, PAD_FLASH_MS);
    flashTimers.add(timer);
  }
  // Keyed on the track as well as the feed: the panel outlives a switch from
  // one drum track to another, and must follow the one it shows.
  const shownTrackId = createMemo(() => props.track.id);
  createEffect(
    () => [props.watchTriggers, shownTrackId()] as const,
    ([watch, trackId]) =>
      watch?.(trackId, (trigger) => {
        if (trigger.kind === "pad") flash(trigger.padId);
      }),
  );
  onCleanup(() => {
    for (const timer of flashTimers) clearTimeout(timer);
  });

  /** Adds an empty pad at the end and selects it, so its sample is the next pick. */
  function addNewPad(): void {
    markFeatureUse();
    const pad = createDrumPad(props.factoryContext ?? defaultFactoryContext, {
      name: nextPadName(pads(props.track)),
    });
    if (props.dispatch(addPad(props.track.id, pad))?.ok) setChosenPad(pad.id);
  }

  function audition(pad: DrumPad): void {
    markFeatureUse();
    props.audition?.(pad.id);
  }

  function padParam(pad: DrumPad, key: string, fallback: number): number {
    const value = pad.parameters[key];
    return value === undefined ? fallback : value;
  }

  return (
    <section class="drum-machine" aria-label={`Drum machine: ${props.track.name}`}>
      {/* The one pad editor (#447): whichever pad is selected, above the
          table, rather than a panel folding open under each row. */}
      <Show when={selectedPad()}>
        {(pad) => (
          <section class="drum-pad-editor" aria-label={`${pad().name} pad`}>
            <div class="drum-pad-editor-head">
              <span class="drum-pad-editor-name">{pad().name}</span>
              <div class="drum-pad-editor-sample">
                <SampleSlot
                  label={`Sample for ${pad().name}`}
                  slot={{ kind: "pad", padId: pad().id }}
                  control={controlAddress(pad().id, CONTROL_PARTS.sample)}
                  name={assetOf(pad())?.name ?? null}
                  onBrowse={() => {
                    markFeatureUse();
                    props.onBrowseSample?.(pad().id);
                  }}
                />
              </div>
            </div>
            <PadSound
              track={props.track}
              pad={pad()}
              asset={assetOf(pad())}
              watchPeaks={props.watchPeaks}
              dispatch={props.dispatch}
              beginGesture={props.beginGesture}
              onFirstUse={markFeatureUse}
            />
          </section>
        )}
      </Show>
      {/* Keyed on the pad's own id, so an edit to a pad updates its lane in
			    place. Keyed on the pad *object* — the default — every parameter edit
			    rebuilds that lane, and a drag applying live would lose the very input
			    it is moving on its first sample. */}
      <Show when={pads(props.track).length > 0}>
        <DataTable
          label={`Pads: ${props.track.name}`}
          class="drum-table"
          headClass="drum-pad drum-pad-head"
          headHidden
          columns={PAD_COLUMNS}
        >
          <For each={pads(props.track)} keyed={(pad) => pad.id}>
            {(pad, index) => (
              // A press anywhere on a row selects its pad; the name button is the
              // same thing for the keyboard.
              <tr
                // Selected is said by the name's pressed button, not the row:
                // the one current thing in a drum machine is the slot the
                // Library is aimed at (UI-002).
                class={[
                  "drum-pad",
                  {
                    muted: pad().mixer.muted,
                    hit: hitPads().has(pad().id),
                    selected: selectedPad()?.id === pad().id,
                  },
                ]}
                onClick={() => setChosenPad(pad().id)}
              >
                <td class="pad-index">{String(index() + 1).padStart(2, "0")}</td>
                <td>
                  <PadName
                    track={props.track}
                    pad={pad()}
                    selected={selectedPad()?.id === pad().id}
                    dispatch={props.dispatch}
                    onAudition={() => {
                      setChosenPad(pad().id);
                      audition(pad());
                    }}
                    onRenamed={() => {
                      markFeatureUse();
                      analytics().logFeatureFirstUse("drum_pad_rename");
                    }}
                  />
                </td>

                {/* The row names its sound; choosing one is the editor's job. */}
                <td class={`pad-sample ${MASK_CONTENT}`}>{sampleName(pad())}</td>

                <td>
                  <PadPreview
                    name={pad().name}
                    assetId={pad().assetId}
                    watchPeaks={props.watchPeaks}
                    onPlay={() => audition(pad())}
                  />
                </td>

                <td>
                  <PadControl
                    trackId={props.track.id}
                    pad={pad()}
                    definition={PAD_PITCH}
                    label="Pitch"
                    value={padParam(pad(), "pitch", PAD_PITCH.defaultValue)}
                    displayValue={formatInstrumentValue(
                      PAD_PITCH,
                      padParam(pad(), "pitch", PAD_PITCH.defaultValue),
                    )}
                    onFirstUse={markFeatureUse}
                    dispatch={(commands) => props.dispatch(commands)}
                    beginGesture={(options) => props.beginGesture(options)}
                  />
                </td>

                <td>
                  <PadControl
                    trackId={props.track.id}
                    pad={pad()}
                    definition={TRACK_VOLUME}
                    label="Level"
                    value={pad().mixer.volume}
                    displayValue={formatDb(TRACK_VOLUME, pad().mixer.volume)}
                    onFirstUse={markFeatureUse}
                    dispatch={(commands) => props.dispatch(commands)}
                    beginGesture={(options) => props.beginGesture(options)}
                  />
                </td>

                <td>
                  <PadControl
                    trackId={props.track.id}
                    pad={pad()}
                    definition={TRACK_PAN}
                    label="Pan"
                    // Pan's range *is* the stereo field, so it fills from centre.
                    bipolar
                    value={pad().mixer.pan}
                    displayValue={formatPan(pad().mixer.pan)}
                    onFirstUse={markFeatureUse}
                    dispatch={(commands) => props.dispatch(commands)}
                    beginGesture={(options) => props.beginGesture(options)}
                  />
                </td>

                <td class="pad-choke-cell">
                  <label class="pad-control pad-choke">
                    <span class="pad-control-label">Choke</span>
                    <select
                      value={pad().chokeGroup === null ? "" : String(pad().chokeGroup)}
                      onChange={(event) =>
                        changeChoke(
                          pad(),
                          event.currentTarget.value === ""
                            ? null
                            : Number(event.currentTarget.value),
                        )
                      }
                    >
                      <option value="">None</option>
                      <For each={CHOKE_GROUPS}>
                        {(group) => <option value={String(group)}>{group + 1}</option>}
                      </For>
                    </select>
                  </label>
                </td>

                <td class="pad-mute-solo-cell">
                  <MuteSoloToggles
                    name={pad().name}
                    muted={pad().mixer.muted}
                    soloed={pad().mixer.soloed}
                    onToggle={(flag) => toggleFlag(pad(), flag)}
                  />
                </td>
              </tr>
            )}
          </For>
        </DataTable>
      </Show>
      <Show when={pads(props.track).length === 0}>
        <p class="drum-machine-empty">This track has no drum pads yet.</p>
      </Show>
      <div class="drum-machine-adds">
        <button
          type="button"
          class="new-track-button"
          aria-label={`Add pad to ${props.track.name}`}
          disabled={full()}
          onClick={addNewPad}
        >
          <HiSolidPlus size={13} />
          <span>Add pad</span>
        </button>
        <Show when={full()}>
          <span class="drum-machine-empty">
            A drum machine holds at most {MAX_DRUM_PADS} pads.
          </span>
        </Show>
      </div>
    </section>
  );
}

/**
 * A pad's sound in miniature (#447): its decoded waveform, and a press plays
 * it, as the pad's name does.
 */
function PadPreview(props: {
  readonly name: string;
  readonly assetId: AssetId | null;
  readonly watchPeaks?: WatchPeaks;
  onPlay(): void;
}): JSX.Element {
  const peaks = createPeaks(
    () => props.watchPeaks,
    () => props.assetId,
    PREVIEW_BUCKETS,
  );
  return (
    <button
      type="button"
      class="pad-preview"
      aria-label={`Preview ${props.name}`}
      onClick={() => props.onPlay()}
    >
      <svg viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true">
        <path
          class="sample-well-bars playing"
          d={peaks() ? peakBars(peaks() as Float32Array, 120, 28) : ""}
        />
      </svg>
    </button>
  );
}
