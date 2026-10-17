/* How tall the assistant's composer is for the text in it (GRV-115): it rests
   at two lines with no scroll bar, grows a line at a time as the producer
   types, and past `COMPOSER_MAX_LINES` stops growing and scrolls. */

export const COMPOSER_MAX_LINES = 10;

/**
 * The height (px, border box) the composer should take. `contentHeight` is the
 * textarea's `scrollHeight` with its height reset to auto, which already
 * includes the vertical padding.
 */
export function composerHeight(
  contentHeight: number,
  lineHeight: number,
  verticalPadding: number,
  maxLines: number = COMPOSER_MAX_LINES,
): number {
  return Math.min(contentHeight, lineHeight * maxLines + verticalPadding);
}

/** Resizes a composer to fit its text. A DOM write; call it from an apply half. */
export function fitComposer(element: HTMLTextAreaElement): void {
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) return;
  const padding =
    Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  element.style.height = "auto";
  element.style.height = `${composerHeight(element.scrollHeight, lineHeight, padding)}px`;
}
