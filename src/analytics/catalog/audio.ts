// Playback: the transport, the loop it obeys, and the audio engine under it.

import { ERROR_CODES } from "../errorCodes";
import {
  type AnalyticsEventDefinition,
  boolParam,
  bucketParam,
  countParam,
  enumParam,
} from "./params";

/**
 * Audio sample rates, as an enumerated key rather than a raw number, so
 * `audio_underrun` cannot carry an unusual exact rate that helps identify a
 * machine. `sampleRateKey()` maps a measured rate onto this set.
 */
export const SAMPLE_RATE_KEYS = [
  "44100",
  "48000",
  "88200",
  "96000",
  "176400",
  "192000",
  "other",
] as const;
export type SampleRateKey = (typeof SAMPLE_RATE_KEYS)[number];

export function sampleRateKey(rate: number): SampleRateKey {
  const candidate = String(Math.round(rate));
  return (SAMPLE_RATE_KEYS as readonly string[]).includes(candidate)
    ? (candidate as SampleRateKey)
    : "other";
}

/** Playback `feature_first_use` keys (see `FEATURE_KEYS`). */
export const AUDIO_FEATURE_KEYS = ["playhead_seek", "swing"] as const;

/** The transport's shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const AUDIO_SHORTCUT_ACTION_IDS = [
  "transport.play_stop",
  "transport.continue",
  "transport.metronome",
  "transport.toggle_loop",
] as const;

export const AUDIO_EVENTS = {
  transport_play: {
    phase: 1,
    owners: ["LOOP-003"],
    params: { is_first_play_in_session: boolParam() },
  },

  loop_range_set: {
    phase: 1,
    owners: ["LOOP-017", "LOOP-018"],
    // One committed change to the song's loop range (AUD-02) — a whole drag,
    // not every pointer move. Only the span's length travels, clamped, so the
    // event says how producers size their loop and nothing about the song.
    params: { bar_count: countParam(64) },
  },

  loop_toggled: {
    phase: 1,
    owners: ["LOOP-017", "LOOP-018"],
    // Whether the transport now obeys the song's loop range: the state the
    // toggle left it in, so on/off rates read straight off the event.
    params: { enabled: boolParam() },
  },

  audio_start_failed: {
    phase: 0,
    owners: ["FND-001c", "LOOP-003"],
    params: {
      error_code: enumParam(ERROR_CODES),
      was_browser_blocked: boolParam(),
    },
  },

  /**
   * A project closed and audio resources it registered were still held
   * (GRV-55): counted by kind, in buckets, never by name. Sampled, like
   * `audio_underrun`, so a leaky session cannot flood the stream; the same
   * sample goes to error monitoring with the `resource_leak` code.
   */
  resources_leaked: {
    phase: 3,
    owners: ["GRV-55"],
    params: {
      node_count_bucket: bucketParam("leak_count"),
      subscription_count_bucket: bucketParam("leak_count"),
      other_count_bucket: bucketParam("leak_count"),
    },
  },

  audio_underrun: {
    phase: 1,
    owners: ["LOOP-003"],
    params: {
      dropped_event_bucket: bucketParam("dropped_events"),
      sample_rate: enumParam(SAMPLE_RATE_KEYS),
    },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
