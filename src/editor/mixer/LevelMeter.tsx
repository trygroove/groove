import type { JSX } from "@solidjs/web";
import "./LevelMeter.css";
import type { TrackLevel } from "../tracks/trackLevels";

export interface LevelMeterProps {
  /**
   * The level to show, read reactively (`useProjectAudio().trackLevel` for a
   * track, `masterLevel` for the master): the editor samples every meter in
   * its one frame loop, so a meter only draws.
   */
  level(): TrackLevel | null;
  /** What the meter is called to assistive tech: "Level" unless given. */
  readonly label?: string;
  /**
   * A mixer strip's meter stands beside its fader; a track header's lies
   * along the row (#447).
   */
  readonly orientation?: "vertical" | "horizontal";
}

/** Floor of the meter display, in dBFS. Below this reads as silence. */
const METER_FLOOR_DB = -60;

export default function LevelMeter(props: LevelMeterProps): JSX.Element {
  const level = () => props.level();
  const clamped = () => {
    const db = level()?.db ?? METER_FLOOR_DB;
    return Number.isFinite(db)
      ? Math.max(METER_FLOOR_DB, Math.min(0, db))
      : METER_FLOOR_DB;
  };
  const fillFraction = () => (clamped() - METER_FLOOR_DB) / -METER_FLOOR_DB;

  // A native <meter> carries the level's role and value for assistive tech for
  // free (no hand-rolled ARIA to drift), while the custom bar overlay gives the
  // VU look a bare <meter> can't be styled into. The two share one value: the
  // overlay's length is the same fraction the <meter> reports. A clip, a peak
  // over 0 dBFS, is the one state shown in colour (#447).
  return (
    <div
      class={[
        props.orientation === "horizontal" ? "level-meter-horizontal" : "mixer-meter",
        { clipping: level()?.clipping ?? false },
      ]}
    >
      <meter
        class="visually-hidden"
        aria-label={props.label ?? "Level"}
        min={METER_FLOOR_DB}
        max={0}
        low={-18}
        high={-6}
        value={clamped()}
      />
      <div
        class="mixer-meter-fill"
        style={{
          [props.orientation === "horizontal" ? "width" : "height"]:
            `${fillFraction() * 100}%`,
        }}
      />
    </div>
  );
}
