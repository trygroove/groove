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
