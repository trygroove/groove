// Editing that works the same on every surface: undo and redo, the clipboard,
// selection, and value fields.

import { type AnalyticsEventDefinition, enumParam } from "./params";

/** Global editing shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const EDITING_SHORTCUT_ACTION_IDS = [
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.select_all",
  "edit.delete",
  "edit.duplicate",
  "value.nudge_up",
  "value.nudge_down",
] as const;

export const EDITING_EVENTS = {
  undo_used: {
    phase: 1,
    owners: ["LOOP-002"],
    params: {
      direction: enumParam(["undo", "redo"]),
      actor: enumParam(["user", "assistant"]),
    },
  },

  /**
   * An undo or redo no longer applied because a change saved in another tab
   * moved what it touched, so it was refused with a toast (GRV-88).
   */
  undo_refused: {
    phase: 1,
    owners: ["GRV-88"],
    params: { direction: enumParam(["undo", "redo"]) },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
