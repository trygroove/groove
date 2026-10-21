// Editing shortcuts that work the same on every surface. Part of the one
// shortcut registry: see `../registry.ts`.

import { define, type ShortcutDefinition } from "./define";

/** Global editing: undo and redo, the clipboard, select all, delete and duplicate. */
export const EDIT_SHORTCUT_IDS = [
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.select_all",
  "edit.delete",
  "edit.duplicate",
] as const;

export const EDIT_SHORTCUTS: readonly ShortcutDefinition[] = [
  define({
    id: "edit.undo",
    label: "Undo",
    description: "Reverts the last edit in this editing session.",
    group: "global_editing",
    contexts: ["global"],
    keys: "Mod+Z",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+Z" },
  }),
  define({
    id: "edit.redo",
    label: "Redo",
    description: "Reapplies the last undone edit.",
    group: "global_editing",
    contexts: ["global"],
    keys: { mac: ["Mod+Shift+Z"], other: ["Mod+Y", "Mod+Shift+Z"] },
    ableton: { kind: "follows", abletonKeys: "Cmd+Shift+Z / Ctrl+Y" },
  }),
  define({
    id: "edit.cut",
    label: "Cut",
    description: "Cuts the current selection to the clipboard.",
    group: "global_editing",
    contexts: ["selection", "arrangement"],
    keys: "Mod+X",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+X" },
  }),
  define({
    id: "edit.copy",
    label: "Copy",
    description: "Copies the current selection to the clipboard.",
    group: "global_editing",
    contexts: ["selection", "arrangement"],
    keys: "Mod+C",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+C" },
  }),
  define({
    id: "edit.paste",
    label: "Paste",
    description: "Pastes the clipboard into the current selection scope.",
    group: "global_editing",
    contexts: ["selection", "arrangement"],
    keys: "Mod+V",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+V" },
  }),
  define({
    id: "edit.select_all",
    label: "Select all",
    description: "Selects everything in the current selection scope.",
    group: "global_editing",
    contexts: ["selection", "arrangement", "step_editor"],
    keys: "Mod+A",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+A" },
  }),
  define({
    id: "edit.delete",
    label: "Delete selection",
    description:
      "Deletes the selected notes, clips, or placements, the device whose header has focus, or a track chosen on its header when nothing inside it is selected.",
    group: "global_editing",
    contexts: [
      "arrangement",
      "step_editor",
      "piano_roll",
      "automation_lane",
      "device_header",
    ],
    keys: ["Delete", "Backspace"],
    ableton: { kind: "follows", abletonKeys: "Delete / Backspace" },
  }),
  define({
    id: "edit.duplicate",
    label: "Duplicate selection",
    description:
      "Duplicates the selected tracks, clips, placements, notes, sections, or automation points, or the device whose header has focus.",
    group: "global_editing",
    contexts: ["selection", "arrangement", "device_header"],
    keys: "Mod+D",
    ableton: { kind: "follows", abletonKeys: "Cmd/Ctrl+D" },
    browserConflict: {
      keys: "Cmd/Ctrl+D",
      note: "Bookmarks the page in most browsers. Groove cancels the default while an editor selection exists, matching Live.",
    },
  }),
];

/** A focused value field's nudges (`ARR-010`). */
export const VALUE_FIELD_SHORTCUT_IDS = ["value.nudge_up", "value.nudge_down"] as const;

export const VALUE_FIELD_SHORTCUTS: readonly ShortcutDefinition[] = [
  define({
    id: "value.nudge_up",
    label: "Nudge value up",
    description: "Raises the focused value field by one step.",
    group: "global_editing",
    contexts: ["value_field"],
    keys: "ArrowUp",
    repeatable: true,
    // The field is text entry, and the arrows are what it is for.
    textEntry: "allowed",
    ableton: { kind: "follows", abletonKeys: "Up" },
  }),
  define({
    id: "value.nudge_down",
    label: "Nudge value down",
    description: "Lowers the focused value field by one step.",
    group: "global_editing",
    contexts: ["value_field"],
    keys: "ArrowDown",
    repeatable: true,
    textEntry: "allowed",
    ableton: { kind: "follows", abletonKeys: "Down" },
  }),
];
