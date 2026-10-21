import type { JSX } from "@solidjs/web";
import type { Device } from "../../domain/entities";
import Well from "../../instrument/Well";
import { useDeviceMeters } from "../mixer/deviceMeters";
import "./LimiterWell.css";

/** The gain-reduction meter's full travel, in dB: past it, the bar is full. */
export const GAIN_REDUCTION_RANGE_DB = 24;

/** A loudness figure as the readout prints it; silence is a dash. */
export function formatLufs(lufs: number): string {
  if (!Number.isFinite(lufs)) return "–";
  const rounded = Math.round(lufs * 10) / 10;
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}`;
}

/** Gain reduction as the well's value prints it, always as a cut. */
export function formatGainReduction(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  return rounded > 0 ? `−${rounded.toFixed(1)} dB` : "0.0 dB";
}

/**
 * The Limiter's well (#937): how hard it is working and how loud its output
 * is. A gain-reduction bar hangs down the right edge, as the faceplate system
 * draws one; beside it the output's loudness in LUFS, short-term (the last
 * three seconds) over integrated (everything since playback last started from
 * the top). The readings come from the editor's frame loop, so outside the
 * editor, or before the first play, the well shows its resting state.
 */
export default function LimiterWell(props: { readonly device: Device }): JSX.Element {
  const meters = useDeviceMeters();
  const reading = () => meters?.(props.device.id) ?? null;
  const reduction = () => Math.max(0, reading()?.gainReductionDb ?? 0);
  return (
    <Well
      title="Loudness"
      value={`GR ${formatGainReduction(reduction())}`}
      scale={["LUFS", "GR"]}
      class="limiter-well"
    >
      <dl class="limiter-loudness">
        <div>
          <dt>Short-term</dt>
          <dd data-testid="limiter-short-term">
            {formatLufs(reading()?.shortTermLufs ?? -Infinity)}
          </dd>
        </div>
        <div>
          <dt>Integrated</dt>
          <dd data-testid="limiter-integrated">
            {formatLufs(reading()?.integratedLufs ?? -Infinity)}
          </dd>
        </div>
      </dl>
      <div class="limiter-gr" title="Gain reduction">
        <meter
          class="visually-hidden"
          aria-label="Gain reduction"
          min={0}
          max={GAIN_REDUCTION_RANGE_DB}
          value={Math.min(GAIN_REDUCTION_RANGE_DB, reduction())}
        />
        <i
          style={{
            height: `${(Math.min(GAIN_REDUCTION_RANGE_DB, reduction()) / GAIN_REDUCTION_RANGE_DB) * 100}%`,
          }}
        />
      </div>
    </Well>
  );
}
