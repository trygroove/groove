import type { JSX } from "@solidjs/web";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import { createControlGesture, setPadParameter } from "../../commands";
import { parameterControl } from "../../commands/controlAddress";
import type { DrumPad, Track } from "../../domain/entities";
import { dbToFaderPosition, faderPositionToDb } from "../../domain/faders";
import {
  clampParameterValue,
  type ParameterDefinition,
  TRACK_VOLUME,
} from "../../domain/parameters";
import FillSlider from "../../instrument/FillSlider";
import { parseParameterInput } from "../../instrument/parseValue";
import { FADER_RANGE } from "../mixer/TrackFaders";

export interface PadControlProps {
  readonly trackId: Track["id"];
  readonly pad: DrumPad;
  readonly definition: ParameterDefinition;
  readonly label: string;
  readonly value: number;
  readonly displayValue: string;
  readonly bipolar?: boolean;
  /** On its side in the pad table's row; standing in the pad editor. */
  readonly orientation?: "horizontal" | "vertical";
  /** The accessible name; by default it says whose pad, as a row must. */
  readonly ariaLabel?: string;
  /** Where the control is, so each copy's input id is its own. */
  readonly idPrefix?: string;
  onFirstUse(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * One continuous pad control (#255): the same thumbless fill slider as every
 * other continuous control in the editor, on its side to fit the pad lane, and
 * driven as one gesture per drag. Each pointer sample applies live inside the
 * open gesture — so the value follows the pointer on screen and in the audio
 * graph — and release commits the whole drag as one history entry, one revision
 * and one save. Dispatching a command straight from `input`, as this did, made
 * one drag dozens of revisions and dozens of undo steps.
 */
export default function PadControl(props: PadControlProps): JSX.Element {
  /**
   * A pad's level is a volume, so it travels on the same perceptual fader law
   * as the mixer's (`DbFader`, #634): the slider moves in `0..1` positions and
   * the command stores decibels. Every other pad value moves in its own units.
   */
  const faderLaw = () => props.definition.id === TRACK_VOLUME.id;
  const toStored = (value: number) =>
    faderLaw() ? faderPositionToDb(props.definition, value) : value;
  const toSlider = (value: number) =>
    faderLaw() ? dbToFaderPosition(props.definition, value) : value;

  const control = createControlGesture({
    beginGesture: (options) => props.beginGesture(options),
    dispatch: (commands) => props.dispatch(commands),
    summary: () => `Set ${props.definition.label} on a pad`,
    command: (value) =>
      setPadParameter(
        props.trackId,
        props.pad.id,
        props.definition.id as Parameters<typeof setPadParameter>[2],
        toStored(value),
      ),
  });

  return (
    <FillSlider
      definition={props.definition}
      control={parameterControl(props.pad.id, props.definition.id)}
      inputId={`${props.idPrefix ?? "pad"}-${props.pad.id}-${props.label.toLowerCase()}`}
      label={props.label}
      // Every pad row shows a "Pitch", so the name has to say whose.
      ariaLabel={props.ariaLabel ?? `${props.label} for ${props.pad.name}`}
      orientation={props.orientation ?? "horizontal"}
      bipolar={props.bipolar}
      range={faderLaw() ? FADER_RANGE : undefined}
      resetValue={faderLaw() ? toSlider(props.definition.defaultValue) : undefined}
      // The field takes decibels; the fader travels in positions.
      parseEntry={
        faderLaw()
          ? (text) => {
              const db = parseParameterInput(props.definition, text);
              return db === null
                ? null
                : toSlider(clampParameterValue(props.definition, db));
            }
          : undefined
      }
      value={toSlider(props.value)}
      displayValue={props.displayValue}
      onInput={(value) => {
        props.onFirstUse();
        control.input(value);
      }}
      onCommit={(value, settle) => control.commit(value, settle)}
    />
  );
}
