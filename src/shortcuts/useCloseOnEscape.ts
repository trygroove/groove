import { useShortcutScope } from "./useShortcutScope";

/**
 * `view.close_surface` (Escape) for a popover or panel that is not modal,
 * called from a component mounted only while the surface is open.
 *
 * Mounting it with the surface makes its scope the newest on the root
 * controller (GRV-186), so its Escape is offered first and, once it runs, to
 * nothing under it: the selection or view behind the popover stays as it was
 * (GRV-148). A modal dialog opened over it (the shortcuts guide, an export or
 * a confirmation) registers a modal scope, which hides this one while it is
 * open, so the dialog closes alone and the next Escape closes the popover.
 */
export function useCloseOnEscape(onClose: () => void): void {
  useShortcutScope({
    handlers: () => ({ "view.close_surface": { run: onClose } }),
    contexts: () => [],
  });
}
