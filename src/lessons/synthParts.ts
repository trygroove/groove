/**
 * A synth track's sound, as the track lesson's chapters read and set it
 * (GRV-44): one of its parameters by name, the command that sets it, and the
 * control it is set on. Pure.
 */
import { parameterControl } from "../commands/controlAddress";
import { setParameter } from "../commands/definitions/parameters";
import type { RawCommandInput } from "../commands/types";
import type { Track } from "../domain/entities";
import {
  bareParameterId,
  type ParameterDefinition,
  readInstrumentParameter,
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_DECAY,
  SYNTH_AMP_RELEASE,
  SYNTH_AMP_SUSTAIN,
  SYNTH_FILTER_CUTOFF,
} from "../domain/parameters";

const SYNTH_PARAMETERS = {
  cutoff: SYNTH_FILTER_CUTOFF,
  attack: SYNTH_AMP_ATTACK,
  decay: SYNTH_AMP_DECAY,
  sustain: SYNTH_AMP_SUSTAIN,
  release: SYNTH_AMP_RELEASE,
} as const satisfies Record<string, ParameterDefinition>;

export type SynthParameter = keyof typeof SYNTH_PARAMETERS;

export type SynthTrack = Track & { readonly instrument: { readonly kind: "synth" } };

export function isSynthTrack(track: Track): track is SynthTrack {
  return track.instrument?.kind === "synth";
}

/** `track`'s value for `name`. */
export function synthValue(track: SynthTrack, name: SynthParameter): number {
  return readInstrumentParameter(SYNTH_PARAMETERS[name], track.instrument.parameters);
}

/** `track`'s filter cutoff, in hertz. */
export function synthCutoff(track: SynthTrack): number {
  return synthValue(track, "cutoff");
}

/** The command that sets `track`'s `name` to `value`. */
export function setSynth(
  track: Track,
  name: SynthParameter,
  value: number,
): RawCommandInput {
  return setParameter(
    {
      scope: "instrument",
      trackId: track.id,
      parameterId: bareParameterId(SYNTH_PARAMETERS[name].id),
    },
    value,
  );
}

/** The control `name` is set on, on `track`'s faceplate. */
export function instrumentControl(track: Track, name: SynthParameter) {
  return parameterControl(track.id, SYNTH_PARAMETERS[name].id);
}
