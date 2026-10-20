// Public surface of the PRD `KEY-01` shortcut layer.
//
// `ShortcutGuide.tsx` is deliberately absent: it is the one module here that
// imports Solid's JSX runtime, and importing this barrel from a non-component
// module (the registry is consumed by tests and docs generation too) should not
// pull a component in. Components import it by name.

export type {
  ChordEvent,
  KeyChord,
  ShortcutPlatform,
} from "./keys";
export {
  chordLabel,
  detectPlatform,
  isShiftAmbiguous,
  keyLabel,
  matchesChord,
  normalizeKey,
  parseChord,
  specLabel,
} from "./keys";
export type {
  ModifierEvent,
  PointerModifierDefinition,
  PointerModifierId,
} from "./pointerGestures";
export {
  POINTER_MODIFIER_IDS,
  POINTER_MODIFIERS,
  pointerModifierById,
  pointerModifierHeld,
  pointerModifierLabel,
  suppressModifierDefault,
} from "./pointerGestures";
export type {
  ShortcutActionId,
  ShortcutDefinition,
  ShortcutKeys,
  ShortcutSection,
} from "./registry";
export {
  chordsFor,
  isInContext,
  keySpecsFor,
  matchShortcut,
  RESERVED_CHORDS,
  resolveContexts,
  SHORTCUT_ACTION_IDS,
  SHORTCUTS,
  shortcutById,
  shortcutLabel,
  shortcutLabels,
  shortcutSections,
  shortcutsInContext,
} from "./registry";
export type {
  ShortcutControllerOptions,
  ShortcutDispatch,
  ShortcutHandler,
  ShortcutHandlers,
  ShortcutRejection,
} from "./ShortcutController";
export { ShortcutController } from "./ShortcutController";
export { isTextEntry } from "./textEntry";
export type {
  AbletonParity,
  BrowserConflict,
  ShortcutContext,
  ShortcutGroup,
} from "./types";
export {
  AMBIENT_CONTEXT,
  MODAL_CONTEXT,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUPS,
} from "./types";
export { modalDialogOpen, useCloseOnEscape } from "./useCloseOnEscape";
export { useShortcuts } from "./useShortcuts";
