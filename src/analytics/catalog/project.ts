// A project's life: created, opened, edited, saved and deleted.

import { ERROR_CODES } from "../errorCodes";
import {
  type AnalyticsEventDefinition,
  boolParam,
  bucketParam,
  countParam,
  enumParam,
  optionalEnumParam,
  UNCLAIMED,
} from "./params";

/**
 * Registered command types, as `first_edit`'s `command_id`.
 *
 * Pinned here rather than derived from `src/commands/registry.ts` because that
 * registry erases its command types to `string`, which would make `command_id`
 * accept free text. `catalog.test.ts` asserts this list equals the registry's
 * exactly, so adding a command without deciding how it appears in analytics
 * fails the suite.
 */
export const COMMAND_IDS = [
  "note.add",
  "note.remove",
  "note.update",
  "notes.clear",
  "notes.duplicate",
  "notes.quantize",
  "notes.scaleVelocity",
  "notes.transpose",
  "notes.vary",
  "notes.quantizeToScale",
  "clip.create",
  "clip.delete",
  "clip.update",
  "track.create",
  "track.delete",
  "track.reorder",
  "track.setFlag",
  "track.update",
  "return.create",
  "return.delete",
  "return.update",
  "send.add",
  "send.remove",
  "placement.create",
  "placement.delete",
  "placement.update",
  "parameter.set",
  "drum.setPadAsset",
  "drum.renamePad",
  "drum.setPadFlag",
  "drum.setPadChoke",
  "drum.setPadParameter",
  "drum.addPad",
  "drum.removePad",
  "drum.reorderPad",
  "instrument.change",
  "instrument.setSample",
  "pack.add",
  "pack.remove",
  "pack.setVersion",
  "asset.add",
  "asset.remove",
  "device.add",
  "device.remove",
  "device.reorder",
  "device.duplicate",
  "device.setBypass",
  "device.reset",
  "device.restoreParameters",
  "loop.setRange",
  "loop.setEnabled",
  "key.set",
  "project.rename",
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** The save states that still hold an unwritten edit, as `unsaved_exit_warned`'s `save_state`. */
export const UNSAVED_SAVE_STATES = ["pending", "saving", "failed"] as const;

export const PROJECT_EVENTS = {
  project_created: {
    phase: 1,
    owners: ["LOOP-001", "LOOP-015"],
    params: {
      source: enumParam(["blank", "template", "duplicate"]),
      // Template keys belong to LOOP-015; genres are the PRD LIB-02 set,
      // pinned here so a library re-tagging cannot rewrite analytics history.
      template_id: optionalEnumParam(UNCLAIMED),
      genre: optionalEnumParam([
        "house",
        "techno",
        "hip_hop",
        "trap",
        "drum_and_bass",
        "jungle",
        "dubstep",
        "ambient",
        "lofi",
        "trance",
        "uk_garage",
        "breakbeat",
        "electronic_pop",
      ]),
    },
  },

  project_opened: {
    phase: 1,
    owners: ["LOOP-001"],
    params: {
      project_age_bucket: bucketParam("project_age"),
      track_count_bucket: bucketParam("track_count"),
      is_first_open: boolParam(),
    },
  },

  project_deleted: {
    phase: 1,
    owners: ["LOOP-001"],
    params: { project_age_bucket: bucketParam("project_age") },
  },

  first_edit: {
    phase: 0,
    owners: ["FND-009"],
    params: {
      command_id: enumParam(COMMAND_IDS),
      seconds_since_open_bucket: bucketParam("elapsed_seconds"),
    },
  },

  save_failed: {
    phase: 0,
    owners: ["FND-001c", "LOOP-002"],
    params: {
      error_code: enumParam(ERROR_CODES),
      retry_count: countParam(20),
    },
  },

  save_recovered: {
    phase: 1,
    owners: ["LOOP-002"],
    params: { retry_count: countParam(20) },
  },

  /**
   * The browser was asked to leave the editor (reload, close, navigate away)
   * while an edit was still unsaved, so the "leave site?" prompt was shown
   * (GRV-60). `save_state` says how far that edit had got.
   */
  unsaved_exit_warned: {
    phase: 1,
    owners: ["GRV-60"],
    params: { save_state: enumParam(UNSAVED_SAVE_STATES) },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
