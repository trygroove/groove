// Tracks and what they carry: instruments, devices, and the mixer they sit in.

import { ERROR_CODES } from "../errorCodes";
import { type AnalyticsEventDefinition, enumParam, optionalEnumParam } from "./params";

/**
 * The instruments a track can carry, as reported by `instrument_changed` and
 * by `track_added` when the added track is created with one.
 */
export const INSTRUMENT_TYPES = ["synth", "sampler", "drum_machine"] as const;
export type InstrumentTypeKey = (typeof INSTRUMENT_TYPES)[number];

/**
 * The device-chain edits that can fail, as `device_edit_failed`'s `operation`
 * (LOOP-020).
 *
 * One value per `device.*` command the chain UI dispatches, so a failure can be
 * attributed to the edit that caused it without carrying the command id (which
 * `first_edit` already owns) or any chain, track, or project identity.
 */
export const DEVICE_OPERATIONS = [
  "add",
  "remove",
  "reorder",
  "duplicate",
  "bypass",
  "reset",
] as const;
export type DeviceOperation = (typeof DEVICE_OPERATIONS)[number];

/** Tracks' and instruments' `feature_first_use` keys (see `FEATURE_KEYS`). */
export const TRACK_FEATURE_KEYS = [
  "drum_machine",
  "synth",
  "sampler",
  "audio_loop",
  "device_chain",
  "send_return",
  "mixer",
  "track_color",
  "track_delete",
  "instrument_add_track",
  "drum_pad_rename",
  // The first EQ added to any chain, and the first band dragged on an EQ's
  // curve (LOOP-022).
  "eq_device",
  "eq_curve",
  // The first Limiter added to any chain (#937).
  "limiter_device",
  // Adding a drum pad from the Sequence view's [+ Pad] row (#947).
  "sequence_add_pad",
] as const;

/** The mixer and device chain's shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const TRACK_SHORTCUT_ACTION_IDS = [
  "device.move_earlier",
  "device.move_later",
  "track.move_left",
  "track.move_right",
  "track.colour_confirm",
] as const;

export const TRACK_EVENTS = {
  track_added: {
    phase: 1,
    owners: ["LOOP-007"],
    params: {
      track_type: enumParam(["instrument", "audio", "return"]),
      // Which instrument the new track was created with. Optional because a
      // track need not carry one (an audio track, a return); `track_type`
      // alone cannot separate a sampler from a synth, and choosing between
      // them is the whole point of the affordance that adds a track (#223).
      instrument_type: optionalEnumParam(INSTRUMENT_TYPES),
    },
  },

  track_reordered: {
    phase: 1,
    owners: ["TRK-02"],
    // One committed reorder (#331): a whole drag, or one move-left/right
    // press — never a position crossed mid-drag. Only where it happened and
    // how; which track moved, and where to, stay out of it. `view`, not
    // `surface`: the boundary attaches `surface` to every event.
    params: {
      view: enumParam(["arrangement", "mixer", "instrument"]),
      method: enumParam(["drag", "button", "keyboard"]),
    },
  },

  instrument_changed: {
    phase: 1,
    owners: ["LOOP-004", "LOOP-005"],
    params: {
      instrument_type: enumParam(INSTRUMENT_TYPES),
    },
  },

  device_added: {
    phase: 1,
    owners: ["LOOP-008", "LOOP-009"],
    params: {
      // The alpha's core device types (LOOP-008); LOOP-009 and LOOP-022 (the
      // EQ) extend this list as they author more. Kept in sync with `src/domain/devices.ts`.
      device_type: enumParam([
        "filter",
        "overdrive",
        "saturator",
        "compressor",
        "delay",
        "reverb",
        "eq",
        "limiter",
      ]),
      chain: enumParam(["insert", "return", "master"]),
    },
  },

  device_edit_failed: {
    phase: 1,
    owners: ["LOOP-020"],
    params: {
      operation: enumParam(DEVICE_OPERATIONS),
      error_code: enumParam(ERROR_CODES),
    },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
