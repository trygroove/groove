/**
 * The space the welcome (GRV-128) leaves below its last control, so a new
 * question can scroll to the middle of the screen and no further: a flat
 * half-screen left hundreds of empty pixels under "Skip to the studio" at the
 * page's end.
 */
export interface RunoutMeasure {
  /** The viewport's height. */
  readonly viewport: number;
  /** The root's `scroll-padding-top`: the fixed header's height. */
  readonly insetTop: number;
  /** The root's `scroll-padding-bottom`. */
  readonly insetBottom: number;
  /** The question's vertical centre, in document coordinates. */
  readonly questionCentre: number;
  /** Where the content ends above the run-out, in document coordinates. */
  readonly contentEnd: number;
}

/**
 * The run-out's height: just enough for the question's centre to reach the
 * middle of the area between the insets, where `scrollIntoView({ block:
 * "center" })` puts it, and never negative.
 */
export function runoutHeight(measure: RunoutMeasure): number {
  const visible = measure.viewport - measure.insetTop - measure.insetBottom;
  const belowCentre = measure.insetBottom + visible / 2;
  const contentBelow = measure.contentEnd - measure.questionCentre;
  return Math.max(0, Math.ceil(belowCentre - contentBelow));
}

/** Measures the page as it stands and sizes `runout` to suit `question`. */
export function fitRunout(question: HTMLElement, runout: HTMLElement): void {
  const root = getComputedStyle(document.documentElement);
  const questionBox = question.getBoundingClientRect();
  runout.style.height = `${runoutHeight({
    viewport: window.innerHeight,
    insetTop: Number.parseFloat(root.scrollPaddingTop) || 0,
    insetBottom: Number.parseFloat(root.scrollPaddingBottom) || 0,
    questionCentre: window.scrollY + questionBox.top + questionBox.height / 2,
    contentEnd: window.scrollY + runout.getBoundingClientRect().top,
  })}px`;
}

/** What the summary's centring measures, in document coordinates. */
export interface RegionMeasure {
  /** The viewport's height. */
  readonly viewport: number;
  /** The root's `scroll-padding-top`: the fixed header's height. */
  readonly insetTop: number;
  /** The root's `scroll-padding-bottom`. */
  readonly insetBottom: number;
  /** The region's top edge. */
  readonly top: number;
  /** The region's bottom edge. */
  readonly bottom: number;
}

/**
 * The scroll position that puts a region in the middle of the area between
 * the insets, where each question sat, or its top just under the header when
 * it is taller than that area. Never negative.
 */
export function centredScrollTop(measure: RegionMeasure): number {
  const visible = measure.viewport - measure.insetTop - measure.insetBottom;
  const height = measure.bottom - measure.top;
  const offset = height >= visible ? 0 : (visible - height) / 2;
  return Math.max(0, measure.top - measure.insetTop - offset);
}

/**
 * Sizes `runout` so the page can scroll far enough to centre the region from
 * `top`'s top edge to `bottom`'s bottom edge, then scrolls it there. The
 * summary (GRV-128) uses it: collapsing the run-out instead shortened the page
 * under the reader, and the summary dropped to the screen's bottom edge.
 */
export function centreRegion(
  top: HTMLElement,
  bottom: HTMLElement,
  runout: HTMLElement,
  behavior: ScrollBehavior,
): void {
  const root = getComputedStyle(document.documentElement);
  const scrollTop = centredScrollTop({
    viewport: window.innerHeight,
    insetTop: Number.parseFloat(root.scrollPaddingTop) || 0,
    insetBottom: Number.parseFloat(root.scrollPaddingBottom) || 0,
    top: window.scrollY + top.getBoundingClientRect().top,
    bottom: window.scrollY + bottom.getBoundingClientRect().bottom,
  });
  const contentEnd = window.scrollY + runout.getBoundingClientRect().top;
  runout.style.height = `${Math.max(0, Math.ceil(scrollTop + window.innerHeight - contentEnd))}px`;
  window.scrollTo?.({ top: scrollTop, behavior });
}
