import { createSignal } from "solid-js";
import { isTextEntry } from "../../shortcuts/textEntry";

/**
 * Where keyboard focus is in the editor: whether it is the arrangement's, the
 * rescue that keeps it from being stranded, and the one value field that has
 * it.
 */

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

/**
 * Focus is never stranded (#76).
 *
 * The editor swaps whole views in and out (`UI-001`: a view you are not on is
 * not on the page at all), deletes the track whose header holds focus, and
 * closes panels whose controls had it. Each time, the element with keyboard
 * focus leaves the document, and the browser drops focus to `<body>`: a
 * keyboard user's next Tab starts again from the top of the page, and a
 * screen reader says nothing at all about where they are.
 *
 * This watches one subtree for exactly that: the element that last had focus
 * inside it is gone and nothing has focus. It then puts focus on the root's
 * *home*, the place the surface on screen now says a keyboard user belongs.
 * It does not take focus from anywhere: a dialog that hands focus back to its
 * opener, or a click that deliberately leaves focus on the page (the
 * arrangement's canvas is not focusable), is left alone.
 *
 * Framework-free, like `ShortcutController`; `EditorView` installs it.
 */
export function installFocusRescue(
  root: HTMLElement,
  home: () => HTMLElement | null,
): () => void {
  const doc = root.ownerDocument;
  /** The element inside `root` that last had focus, while it may still be lost. */
  let last: Element | null = null;

  const nothingFocused = (): boolean =>
    doc.activeElement === null || doc.activeElement === doc.body;

  const onFocusIn = (event: FocusEvent): void => {
    last = event.target instanceof Element ? event.target : null;
  };

  // Focus moved to nothing while its element is still on the page: a click on
  // something that does not take focus. That is the user's choice, not loss.
  const onFocusOut = (event: FocusEvent): void => {
    const target = event.target;
    queueMicrotask(() => {
      if (target === last && last?.isConnected && nothingFocused()) last = null;
    });
  };

  const lost = (): boolean => last !== null && !last.isConnected && nothingFocused();

  // A task later, not straight away: a component that hands focus on itself
  // (a dialog to its opener, a rename field to its name) does it in an effect
  // or a microtask, and wins. Only focus nobody claimed is rescued.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const rescue = (): void => {
    if (!lost() || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!lost()) return;
      last = null;
      home()?.focus({ preventScroll: true });
    }, 0);
  };

  const observer = new MutationObserver(rescue);
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  return () => {
    clearTimeout(pending);
    observer.disconnect();
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("focusout", onFocusOut);
  };
}

/**
 * What the shortcut registry reaches in the focused value field (ARR-010):
 * `value.nudge_up`/`value.nudge_down` nudge it. Escape is not the field's: it
 * closes the dialog the field sits in, as everywhere (#650). The field never
 * reads a key itself.
 */
export interface FocusedValueField {
  nudge(direction: 1 | -1): void;
}

// One field has focus at a time, so the editor needs one slot, not a registry.
const [focused, setFocused] = createSignal<FocusedValueField | null>(null);

/** The value field with focus, if any; the editor's shortcut contexts read it. */
export const focusedValueField = focused;

export function focusValueField(field: FocusedValueField): void {
  setFocused(() => field);
}

export function blurValueField(field: FocusedValueField): void {
  if (focused() === field) setFocused(null);
}
