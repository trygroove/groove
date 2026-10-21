import { isTextEntry } from "../../shortcuts/textEntry";

/**
 * Whether keyboard focus is the arrangement's (#835): nothing has focus (a
 * click on the timeline canvas leaves it on the body, since the canvas is not
 * focusable), or a control inside the arrangement that is not a typing target
 * does. A text field, a dialog, or a portalled popover such as the track colour
 * menu takes focus when it opens, so each keeps Cmd/Ctrl+A and Escape for
 * itself rather than having them reach the arrangement's selection.
 */
export function arrangementHasFocus(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body) return true;
  return !isTextEntry(active) && active.closest(".arrangement-view") !== null;
}
