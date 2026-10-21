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
