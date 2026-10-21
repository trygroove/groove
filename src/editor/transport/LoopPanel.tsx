import { For, type JSX, Show } from "@solidjs/web";
import type { Asset, Clip } from "../../domain/entities";
import type { AssetId } from "../../domain/ids";
import { BEATS_PER_BAR, ticksToBars } from "../../domain/time";
import ControlGroup from "../../instrument/ControlGroup";
import SampleSlot from "../../instrument/SampleSlot";
import { createPeaks, peakBars, type WatchPeaks } from "../../instrument/SampleWell";
import Well from "../../instrument/Well";
import { loopStretchRatio } from "./LoopInfo";
import "../../instrument/InstrumentPanel.css";
import "./LoopPanel.css";

export interface LoopPanelProps {
  /** The track's name, which names the panel's region. */
  readonly trackName: string;
  /** The track's tempo-labelled loop clip, or null when it carries none. */
  readonly clip: Clip | null;
  /** That clip's asset, or null when it cannot be resolved. */
  readonly asset: Asset | null;
  readonly songTempo: number;
  readonly watchPeaks?: WatchPeaks;
  /** The instrument header row, the panel's first row (#447). */
  readonly header?: JSX.Element;
  /** Opens the library on loops, to choose the loop this track plays. */
  onBrowse?(): void;
}

const WIDTH = 960;
const HEIGHT = 140;
const BUCKETS = 480;

/** A value to two places, without trailing zeros: 1, 1.5, 1.33. */
function round2(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function plural(count: number, one: string): string {
  return `${round2(count)} ${count === 1 ? one : `${one}s`}`;
}

/** One key fact about the loop: its value above, its name below, like a fader. */
function Readout(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="loop-readout">
      <span class="loop-readout-value">{props.value}</span>
      <span class="loop-readout-label">{props.label}</span>
    </div>
  );
}

/**
 * The faceplate for a loop track (#447): an audio track carries no instrument,
 * so instead of the instrument picker it shows the loop it plays, drawn in a
 * well over its bar and beat grid, and the facts that decide how it sounds.
 * The "Loop" group's sample slot chooses the loop, the same slot the sampler
 * and the drum pads choose their sounds with; the "Source" and "Stretch" banks
 * are readouts, where loop points and time-stretch controls will sit when the
 * domain grows them.
 */
export default function LoopPanel(props: LoopPanelProps): JSX.Element {
  const loop = () =>
    props.clip?.content.kind === "audioLoop" ? props.clip.content : null;
  const assetId = (): AssetId | null => (props.asset ? props.asset.id : null);
  const peaks = createPeaks(() => props.watchPeaks, assetId, BUCKETS);
  const bars = () => (props.clip ? ticksToBars(props.clip.lengthTicks) : 0);
  const ratio = () => loopStretchRatio(loop()?.sourceTempo ?? 0, props.songTempo);
  const beatLines = () => {
    const beats = Math.round(bars() * BEATS_PER_BAR);
    return Array.from({ length: Math.max(0, beats - 1) }, (_, index) => ({
      x: ((index + 1) / beats) * WIDTH,
      bar: (index + 1) % BEATS_PER_BAR === 0,
    }));
  };

  // The slot is the way into the library (UI-001), as it is on the sampler: it
  // names the loop, and opening it is how the loop changes.
  const slotGroup = () => (
    <Show when={props.onBrowse}>
      {(browse) => (
        <div class="instrument-panel-group loop-slot-group">
          <div class="control-group-head">
            <h3 class="control-group-title">Loop</h3>
          </div>
          <SampleSlot
            label={`Loop for ${props.trackName}`}
            slot={{ kind: "loop" }}
            name={props.asset?.name ?? null}
            placeholder="No loop loaded"
            onBrowse={browse()}
          />
        </div>
      )}
    </Show>
  );

  return (
    <section class="instrument-panel loop-panel" aria-label={`${props.trackName} loop`}>
      {props.header}
      <Show
        when={loop()}
        fallback={
          <>
            {slotGroup()}
            <p class="loop-panel-empty">This audio track has no loop on it yet.</p>
          </>
        }
      >
        {(content) => (
          <>
            <Well
              title={`Waveform · ${plural(bars(), "bar")}`}
              value={`${content().sourceTempo} BPM`}
              class="loop-well"
            >
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <For each={beatLines()}>
                  {(line) => (
                    <line
                      class={line.bar ? "loop-well-bar" : "well-grid"}
                      x1={line.x}
                      x2={line.x}
                      y1="0"
                      y2={HEIGHT}
                    />
                  )}
                </For>
                <line
                  class="well-grid"
                  x1="0"
                  x2={WIDTH}
                  y1={HEIGHT / 2}
                  y2={HEIGHT / 2}
                />
                <path
                  class="sample-well-bars playing"
                  d={peaks() ? peakBars(peaks() as Float32Array, WIDTH, HEIGHT) : ""}
                />
              </svg>
              <Show when={!props.asset || (props.watchPeaks && !peaks())}>
                <p class="sample-well-empty">
                  {props.asset ? "Loading waveform…" : "Loop audio is unavailable"}
                </p>
              </Show>
            </Well>
            <div class="loop-panel-banks">
              {slotGroup()}
              <ControlGroup title="Source">
                <Readout label="Source tempo" value={`${content().sourceTempo} BPM`} />
                <Readout label="Length" value={plural(bars(), "bar")} />
                <Readout
                  label="Duration"
                  value={
                    props.asset?.durationSeconds == null
                      ? "–"
                      : `${round2(props.asset.durationSeconds)} s`
                  }
                />
              </ControlGroup>
              <ControlGroup title="Stretch">
                <Readout label="Playing at" value={`${props.songTempo} BPM`} />
                <Readout label="Ratio" value={`${round2(ratio())}×`} />
                <Readout label="Pitch" value="Held" />
              </ControlGroup>
            </div>
            <p class="loop-panel-note">
              The loop follows the song's tempo by time-stretching, so it keeps the key it
              was recorded in.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
