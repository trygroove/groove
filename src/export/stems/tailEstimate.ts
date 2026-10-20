import { SILENCE_THRESHOLD, songEndSeconds } from "../../audio/renderLength";
import { computePlacementSchedule } from "../../audio/scheduling";
import { defaultDeviceParameters, delayDivision } from "../../domain/devices";
import type { Device, Instrument } from "../../domain/entities";
import {
  readInstrumentParameter,
  SAMPLER_AMP_RELEASE,
  SYNTH_AMP_RELEASE,
} from "../../domain/parameters";
import { ticksToSeconds } from "../../domain/time";
import type {
  AudioSongProjection,
  AudioTrackProjection,
} from "../../projection/audioProjection";

/**
 * How far past the song a render is expected to ring, before rendering it.
 *
 * The offline renderer trims each stem back to its last audible sample, so a
 * release or an effect tail past the last clip is part of the file (EXP-001).
 * The only exact answer is to render; this is the model the Export dialog
 * sizes the files by, so the size it shows is close to what downloads. It
 * follows the signal: when a track's last sound ends, how long its instrument
 * releases, then how long each device in its chain, the return buses it sends
 * to and the master keep ringing above the render's silence threshold. It
 * never exceeds `maxTailSeconds`, the longest the renderer keeps.
 */

type Values = Readonly<Record<string, number>>;

function valuesOf(device: Device): Values {
  return { ...defaultDeviceParameters(device.type), ...device.parameters };
}

/**
 * The level a track's signal is taken to reach an effect at: -18 dBFS, a
 * typical mixed source. A tail rings until it falls to the render's silence
 * threshold, so its length depends on how loud it starts; assuming full scale
 * counted close to a second of reverb the render had already trimmed as
 * silence (GRV-162). Measured against Chromium renders, a single synth note
 * reaches an effect a little under this and a loud chord a little over.
 */
const SOURCE_LEVEL = 0.125;

/**
 * The gain a reverb's convolver gives a sustained source, per square root of
 * its impulse's length in seconds. Web Audio normalizes every impulse to the
 * same power (`GainCalibration` 0.00125, at 44.1 kHz), so a longer impulse
 * spreads that power thinner per sample but sums more of the source: the
 * tail's level grows with the root of its length. Taken at 48 kHz, the
 * projects' usual rate; at 44.1 kHz it is 4% louder, a few milliseconds of tail.
 */
const CONVOLVER_GAIN = (0.00125 * 44_100) / Math.sqrt(48_000);

/** Seconds a decay of amplitude `exp(-t / timeConstant)` takes from `level` to silence. */
function secondsToSilence(level: number, timeConstant: number): number {
  return level <= SILENCE_THRESHOLD
    ? 0
    : timeConstant * Math.log(level / SILENCE_THRESHOLD);
}

/** How long one device keeps sounding after its input stops. */
export function deviceTailSeconds(device: Device, tempo: number): number {
  if (device.bypassed) return 0;
  const values = valuesOf(device);
  const wet = values.wet ?? 1;
  switch (device.type) {
    case "reverb": {
      if (wet <= SILENCE_THRESHOLD) return 0;
      // The impulse: decay stretched by size, exponential to 90%, then a ramp.
      const decay = values.decay * (0.5 + values.size);
      const preDelay = values.predelay + values.size * 0.05;
      const timeConstant = Math.log(decay + 1) / Math.log(200);
      const level = wet * SOURCE_LEVEL * CONVOLVER_GAIN * Math.sqrt(decay + preDelay);
      return Math.min(decay + preDelay, preDelay + secondsToSilence(level, timeConstant));
    }
    case "delay": {
      const time =
        values.sync >= 0.5
          ? (240 / (tempo > 0 ? tempo : 120)) * delayDivision(values.division).wholeNotes
          : values.time;
      const feedback = values.feedback;
      const level = wet * SOURCE_LEVEL;
      if (level <= SILENCE_THRESHOLD) return 0;
      const repeats =
        feedback > 0 && feedback < 1
          ? Math.ceil(Math.log(SILENCE_THRESHOLD / level) / Math.log(feedback))
          : feedback >= 1
            ? Number.POSITIVE_INFINITY
            : 0;
      return time * (1 + Math.max(0, repeats));
    }
    default:
      return 0;
  }
}

function chainTailSeconds(devices: readonly Device[], tempo: number): number {
  return devices.reduce((sum, device) => sum + deviceTailSeconds(device, tempo), 0);
}

function releaseSeconds(instrument: Instrument | null): number {
  if (instrument?.kind === "sampler")
    return readInstrumentParameter(SAMPLER_AMP_RELEASE, instrument.parameters);
  if (instrument?.kind === "synth")
    return readInstrumentParameter(SYNTH_AMP_RELEASE, instrument.parameters);
  return 0;
}

/** When a track's last sound stops, in seconds from bar 1, release included. */
function trackSoundEndSeconds(
  projection: AudioSongProjection,
  track: AudioTrackProjection,
): number {
  const { tempo, swing } = projection;
  const durationOf = (assetId: string | null) =>
    projection.assets.find((asset) => asset.id === assetId)?.durationSeconds ?? 0;
  const release = releaseSeconds(track.instrument);
  let end = 0;
  for (const placement of projection.placements) {
    if (placement.trackId !== track.id) continue;
    const clip = projection.clipsById.get(placement.clipId);
    if (!clip) continue;
    const { notes, audioLoops } = computePlacementSchedule(placement, clip, tempo, swing);
    for (const note of notes) {
      const start = ticksToSeconds(note.absoluteTicks, tempo);
      let sound = ticksToSeconds(note.durationTicks, tempo) + release;
      if (track.instrument?.kind === "drumMachine" && note.trigger.kind === "pad") {
        const padId = note.trigger.padId;
        const pad = track.instrument.pads.find((candidate) => candidate.id === padId);
        sound = Math.max(sound, durationOf(pad?.assetId ?? null));
      }
      end = Math.max(end, start + sound);
    }
    for (const loop of audioLoops) {
      end = Math.max(end, ticksToSeconds(loop.absoluteTicks + loop.durationTicks, tempo));
    }
  }
  return end;
}

/**
 * Seconds a render of `projection` is expected to run past the end of its last
 * placement, at most `maxTailSeconds`. Zero when nothing rings past the song.
 */
export function estimateTailSeconds(
  projection: AudioSongProjection,
  maxTailSeconds: number,
): number {
  const { tempo } = projection;
  const songEnd = songEndSeconds(projection);
  const returnTail = new Map(
    projection.returns.map((bus) => [bus.id, chainTailSeconds(bus.devices, tempo)]),
  );
  const masterTail = chainTailSeconds(projection.master.devices, tempo);
  let ringsUntil = songEnd;
  for (const track of projection.tracks) {
    const sounds = trackSoundEndSeconds(projection, track);
    if (sounds === 0) continue;
    const own = sounds + chainTailSeconds(track.devices, tempo);
    const sent = track.sendConfig
      .filter((send) => send.level > 0)
      .map((send) => returnTail.get(send.returnId) ?? 0);
    ringsUntil = Math.max(
      ringsUntil,
      sounds,
      own + masterTail,
      ...sent.map((tail) => own + tail + masterTail),
    );
  }
  return Math.min(maxTailSeconds, Math.max(0, ringsUntil - songEnd));
}
