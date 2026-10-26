// Tempo-labelled audio-loop panel: tells a loop from a pitched one-shot and
// describes the pitch-preserving stretch honestly (LOOP-006/INS-02).

import { type JSX, Show } from "@solidjs/web";
import { HiSolidArrowsRightLeft, HiSolidMusicalNote } from "solid-icons/hi";
import type { Asset, Clip } from "../../domain/entities";
import { ticksToBars } from "../../domain/time";
import "./LoopInfo.css";

export interface LoopInfoProps {
  /** The audio-loop clip to describe. */
  readonly clip: Clip;
  /** The clip's resolved asset, or `null`/`undefined` when it is missing. */
  readonly asset: Asset | null | undefined;
  /** The current song tempo, so the panel can report the live stretch amount. */
  readonly songTempo: number;
}

/** Rounds a possibly-fractional bar count for display without lying about it. */
function formatBars(lengthTicks: number): string {
  const bars = ticksToBars(lengthTicks);
  const rounded = Math.round(bars * 100) / 100;
  return `${rounded} ${rounded === 1 ? "bar" : "bars"}`;
}

/**
 * How far the loop is being stretched to fit the song: song tempo over source
 * tempo. Above 1 the loop is compressed into less time, below 1 it is spread
 * over more. The stretch is pitch-preserving, so this ratio is the *only* thing
 * the tempo difference changes — and it is also what sets how audible the
 * granular artefacts are, which is why the panel shows it.
 */
export function loopStretchRatio(sourceTempo: number, songTempo: number): number {
  if (sourceTempo <= 0 || songTempo <= 0) return 1;
  return songTempo / sourceTempo;
}

function formatStretchRatio(ratio: number): string {
  const rounded = Math.round(ratio * 100) / 100;
  return `${rounded}×`;
}

/**
 * LOOP-006 / INS-02: the surface that distinguishes a tempo-labelled audio
 * loop from a pitched one-shot sample and documents the alpha's stretch
 * behaviour honestly.
 *
 * The loop follows project tempo by *time-stretching*: it is played over more
 * or less time while its pitch is held where it was recorded, so moving a
 * song from 90 to 120 BPM does not transpose the loop. What that costs is
 * stated here rather than hidden — granular stretching softens transients and
 * adds a faint texture, and both grow with the stretch ratio. That honesty is
 * an acceptance criterion, not a nicety: a user reaching for a loop needs to
 * know why a big tempo move sounds smeared but never out of tune.
 */
export default function LoopInfo(props: LoopInfoProps): JSX.Element {
  // Only audio-loop clips are described here; a note clip is a pitched-content
  // clip and renders nothing.
  return (
    <Show when={props.clip.content.kind === "audioLoop" ? props.clip.content : null}>
      {(content) => {
        // Derived values are accessors, not consts: this render callback runs once
        // per loop clip, so a plain const would freeze the ratio at the tempo it
        // was first shown at (GRV-218).
        const sourceTempo = () => content().sourceTempo;
        const ratio = () => loopStretchRatio(sourceTempo(), props.songTempo);
        const stretched = () => Math.abs(ratio() - 1) >= 0.005;
        return (
          <section class="loop-info" aria-label="Audio loop">
            <div class="loop-info-header">
              <span class="loop-badge loop-badge-tempo">
                <HiSolidArrowsRightLeft size={14} aria-hidden="true" />
                Tempo-labelled loop
              </span>
              <Show
                when={props.asset}
                fallback={
                  <span class="loop-asset loop-asset-missing">
                    Loop audio is unavailable
                  </span>
                }
              >
                {(asset) => <span class="loop-asset">{asset().name}</span>}
              </Show>
            </div>
            <dl class="loop-info-facts">
              <div class="loop-fact">
                <dt>Source tempo</dt>
                <dd>{sourceTempo()} BPM</dd>
              </div>
              <div class="loop-fact">
                <dt>Length</dt>
                <dd>{formatBars(props.clip.lengthTicks)}</dd>
              </div>
              <div class="loop-fact">
                <dt>Playing at</dt>
                <dd>{props.songTempo} BPM</dd>
              </div>
              <div class="loop-fact">
                <dt>Stretch</dt>
                <dd>{formatStretchRatio(ratio())}</dd>
              </div>
            </dl>
            <p class="loop-stretch-note">
              {/* The class rides a wrapper because `solid-icons@1.2.0` types
                  `IconProps` off `JSX.SVGElementTags` imported from `solid-js`,
                  which no longer exports a `JSX` namespace — so `class` is not
                  on the icon's prop type under Solid 2. The span carries the
                  same two cosmetic declarations to the same effect. */}
              <span class="loop-stretch-icon">
                <HiSolidMusicalNote size={14} aria-hidden="true" />
              </span>
              This loop follows the project tempo by time-stretching, which preserves
              pitch: it plays over more or less time, but stays in the key it was recorded
              in.{" "}
              <Show
                when={stretched()}
                fallback={
                  <span class="loop-stretch-live">
                    At {props.songTempo} BPM it plays at its source tempo, so it is played
                    back untouched, with no stretching at all.
                  </span>
                }
              >
                <span class="loop-stretch-live">
                  At {props.songTempo} BPM it is stretched {formatStretchRatio(ratio())}.
                  Stretching is granular, so it softens transients and adds a faint
                  texture — the further from 1× it goes, the more you will hear that.
                </span>
              </Show>
            </p>
            <p class="loop-contrast-note">
              A pitched one-shot sample plays at a fixed pitch you choose and does not
              follow the tempo — this clip is a loop, so it does.
            </p>
          </section>
        );
      }}
    </Show>
  );
}
