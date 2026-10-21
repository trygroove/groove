import type { JSX } from "@solidjs/web";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import {
  createControlGesture,
  type ParameterTarget,
  parameterTargetControl,
  setParameter,
} from "../../commands";
import type { Track } from "../../domain/entities";
import { dbToFaderPosition, faderPositionToDb, formatDb } from "../../domain/faders";
import {
  clampParameterValue,
  type ParameterDefinition,
  TRACK_VOLUME,
} from "../../domain/parameters";
import FillSlider from "../../instrument/FillSlider";
import { parseParameterInput } from "../../instrument/parseValue";

/**
 * The volume fader's own coordinate space: a normalized fader position, not the
 * decibels it writes. `src/domain/faders.ts` maps between the two so the travel
 * is perceptual rather than linear in dB.
 */
export const FADER_RANGE = { min: 0, max: 1, step: 0.001 } as const;

export interface FaderProps {
  readonly track: Track;
  readonly value: number;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The range input's id; each surface a track is shown on needs its own. */
  readonly inputId?: string;
  /** A mixer strip's fader stands; a track header's lies along it (#447). */
  readonly orientation?: "vertical" | "horizontal";
}

export interface DbFaderProps {
  /** The volume parameter the fader sets: a track's or the master's. */
  readonly definition: ParameterDefinition;
  readonly target: ParameterTarget;
  /** The current value, in dB. */
  readonly value: number;
  readonly inputId: string;
  readonly ariaLabel: string;
  /** The history entry's words for a drag. */
  readonly summary: string;
  readonly orientation?: "vertical" | "horizontal";
  /** Called once per landed change, for a surface's first-use analytics. */
  onCommit?(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * A volume fader on the perceptual law (`src/domain/faders.ts`): it travels
 * in positions and writes decibels, takes typed decibels in its field, and
 * lands a drag as one gesture. The track's and the master's are both this.
 */
export function DbFader(props: DbFaderProps): JSX.Element {
  const control = createControlGesture({
    beginGesture: (options) => props.beginGesture(options),
    dispatch: (commands) => props.dispatch(commands),
    summary: () => props.summary,
    command: (position) =>
      setParameter(props.target, faderPositionToDb(props.definition, position)),
  });

  return (
    <FillSlider
      definition={props.definition}
      control={parameterTargetControl(props.target)}
      inputId={props.inputId}
      orientation={props.orientation}
      label="Vol"
      ariaLabel={props.ariaLabel}
      range={FADER_RANGE}
      resetValue={dbToFaderPosition(props.definition, props.definition.defaultValue)}
      value={dbToFaderPosition(props.definition, props.value)}
      displayValue={formatDb(props.definition, props.value)}
      // The field takes decibels; the fader travels in positions.
      parseEntry={(text) => {
        const db = parseParameterInput(props.definition, text);
        return db === null
          ? null
          : dbToFaderPosition(
              props.definition,
              clampParameterValue(props.definition, db),
            );
      }}
      onInput={(position) => control.input(position)}
      onCommit={(position, settle) => {
        control.commit(position, settle);
        props.onCommit?.();
      }}
    />
  );
}

/** A track's volume fader. */
export function VolumeFader(props: FaderProps): JSX.Element {
  return (
    <DbFader
      definition={TRACK_VOLUME}
      target={{ scope: "track", trackId: props.track.id, parameterId: TRACK_VOLUME.id }}
      value={props.value}
      inputId={props.inputId ?? `mixer-volume-${props.track.id}`}
      ariaLabel={`Volume for ${props.track.name}`}
      summary={`Set volume for ${props.track.name}`}
      orientation={props.orientation}
      dispatch={props.dispatch}
      beginGesture={props.beginGesture}
    />
  );
}
