import type { ShortcutHandlers } from "./ShortcutController";
import type { ShortcutContext } from "./types";
import { type ShortcutScopeHandle, useShortcutScope } from "./useShortcutScope";

/**
 * Registers a surface's shortcuts on the app's one controller for the lifetime
 * of the calling component (PRD `KEY-01`).
 *
 * The surfaces still calling this (the editor, the Mixer, the device chain)
 * move to `useShortcutScope` in GRV-186's second PR. Until then this is that
 * hook under its old name, not a controller of its own: a controller attached
 * beside the root would be offered every press ahead of the dialogs and
 * popovers registered on the root after it (GRV-148), so the surface on top
 * would not get its Escape first.
 */
export function useShortcuts(options: {
  handlers: () => ShortcutHandlers;
  contexts: () => readonly ShortcutContext[];
}): ShortcutScopeHandle {
  return useShortcutScope(options);
}
