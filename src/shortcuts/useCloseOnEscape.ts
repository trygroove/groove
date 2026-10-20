import { useShortcutScope } from "./useShortcutScope";

/** Whether a modal dialog is open anywhere in the document. */
export function modalDialogOpen(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/**
 * `view.close_surface` (Escape) for a popover or panel that is not modal,
 * called from a component mounted only while the surface is open.
 *
 * Mounting it with the surface makes its scope the newest on the root
 * controller (GRV-186), so its Escape is offered first and, once it runs, to
 * nothing under it: the selection or view behind the popover stays as it was
 * (GRV-148). A modal dialog opened over it (the shortcuts guide, an export or
 * a confirmation) is on top even when its Escape belongs to an older scope, as
 * the guide's belongs to the editor's, so while one is open this stands down
 * and the dialog closes alone; the next Escape closes the popover.
 */
export function useCloseOnEscape(onClose: () => void): void {
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": { run: onClose, isEnabled: () => !modalDialogOpen() },
    }),
    contexts: () => [],
  });
}
