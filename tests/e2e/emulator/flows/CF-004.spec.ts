import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-004` — a producer sets the span they are working in.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LOOP-018` (#280)
 * and is frozen once it lands: a later PR that changes an assertion here has to
 * say so in its body and justify it.
 *
 * `test.fixme` because none of the loop-brace surface exists yet — #280 is the
 * PR that removes this marker. What is missing today:
 *
 *  - **The brace itself.** `src/arrangement/canvasRenderer.ts` draws the ruler,
 *    sections and playhead; nothing draws a loop brace, and nothing lets a
 *    pointer grab one. #280's own acceptance criteria put it in the same paint
 *    pass rather than in an overlay element.
 *  - **Its persistence.** `songSchema` (`src/domain/entities.ts`) has no loop
 *    range or loop toggle, so step 7's reload has nothing to reopen with. That
 *    is #278, which lands before #280.
 *  - **Looping on by default.** `useProjectAudio` starts with
 *    `loopEnabled = false` today, so step 1's "looping is on" is new too.
 *
 * Runs against the Firestore/Auth emulator rather than the mock backend,
 * because step 7 is a real `page.reload()` and the mock repository is a fresh,
 * empty store on every page load.
 *
 * Two requirements this spec places on #280, both because the ruler is a canvas
 * and canvas pixels can never be the only representation of state (PRD 9.3, and
 * the same rule `ArrangementView`'s existing hidden mirrors already follow):
 *
 *  1. **An accessible mirror of the brace**, at
 *     `data-testid="arrangement-loop-live"`, naming the *inclusive* first and
 *     last bar with the one bar wording #292 set: a brace over the first bar
 *     alone reads "bar 1", and one over bars 1 and 2 reads "bars 1 to 2".
 *     #280 already owes assistive technology an announcement of the brace;
 *     this is that announcement, read by a test.
 *  2. **The timeline's horizontal scale**, as `data-pixels-per-tick` on the
 *     arrangement root. Step 3 is a pointer drag on a canvas, so it can only be
 *     performed by coordinate, and a spec that hardcoded the zoom constant
 *     would break the first time anyone changed it.
 */

/** One bar of the alpha's fixed 4/4 at 192 PPQ (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/** The ruler strip's height in CSS pixels (`canvasRenderer.RULER_HEIGHT_PX`). */
const RULER_HEIGHT_PX = 22;

/** Beats per bar, for reading the transport's bar.beat readout as one number. */
const BEATS_PER_BAR = 4;

/**
 * The arrangement's accessible mirror of the loop brace (see the note above).
 */
const loopBrace = (page: Page): Locator => page.getByTestId("arrangement-loop-live");

/**
 * The interaction canvas the ruler is drawn on. A class, deliberately: it is a
 * `<canvas>`, so it has no role and no accessible name to reach it by, and the
 * drag in step 3 needs the element's box to compute coordinates from.
 */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The transport's playhead readout, by the accessible text `EditorHeader` gives it. */
const playheadReadout = (page: Page): Locator =>
  page.getByText(/^Playhead at bar \d+\.\d+$/);

/** The playhead's position as whole beats from the top of the song. */
async function playheadBeats(page: Page): Promise<number> {
  const text = (await playheadReadout(page).textContent()) ?? "";
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not read the playhead readout: "${text}"`);
  return (Number(match[1]) - 1) * BEATS_PER_BAR + (Number(match[2]) - 1);
}

/** The bar the playhead is in, 1-based, as the transport shows it. */
const barOf = (beats: number): number => Math.floor(beats / BEATS_PER_BAR) + 1;

/**
 * Watches the playhead for a while and reports where it went.
 *
 * Musical time is wall-clock time here: one bar is two seconds at the tempo a
 * new project opens at, so a window that covers a loop pass has to be seconds
 * long. Sampling the readout is the only way to see a *turnaround* — an
 * assertion on a single reading cannot tell "looping over bar 1" apart from
 * "stopped at bar 1".
 */
async function watchPlayhead(page: Page, milliseconds: number): Promise<number[]> {
  const samples: number[] = [];
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    samples.push(await playheadBeats(page));
    await page.waitForTimeout(40);
  }
  return samples;
}

/** Whether the playhead ever jumped backwards — i.e. the loop turned it around. */
const turnedAround = (samples: readonly number[]): boolean =>
  samples.some((beats, index) => index > 0 && beats < samples[index - 1]);

test.describe("CF-004", () => {
  // `test.fixme` until #280 (LOOP-018) lands: that PR removes this marker in
  // the same diff that makes the flow pass.
  test("a producer sets the span they are working in", async ({ page, browserName }) => {
    // Several loop passes are watched in real time, and a bar is two seconds
    // at 120 BPM, so this flow does not fit the default per-test timeout.
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-004",
      title: "A producer sets the span they are working in",
    });

    /*
     * Playback is asserted in Chromium only — the known, tracked gap CF-001
     * and `tests/e2e/emulator/slice.spec.ts` already carry. In Firefox here a
     * fresh `AudioContext` constructs and reports `state="suspended"`, but
     * `resume()` never settles, so `play()` times out into
     * `audio_start_failed`. See docs/testing.md, "Playback is asserted in
     * Chromium only", and issue #43.
     *
     * Everything the brace itself promises — where it starts, that a drag
     * moves it, that it survives a reload, and that the loop toggle is
     * independent of it — runs in both gating browsers. Only the assertions
     * about where the *playhead* went are guarded.
     */
    const canAssertPlayback = browserName === "chromium";
    test.info().annotations.push({
      type: canAssertPlayback ? "playback-asserted" : "playback-skipped",
      description: canAssertPlayback
        ? `playback asserted in ${browserName}`
        : `playback not asserted in ${browserName}: AudioContext.resume() is refused here — see HARD-001`,
    });

    // 1. Create a new project. Above the tracks, the ruler carries a loop
    //    brace spanning the first bar, and looping is on.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await expect(loopBrace(page)).toContainText("bar 1");
    // The toggle names the action it offers, so "Disable loop" is what a
    // control that is currently looping reads (`EditorHeader`).
    await expect(page.getByRole("button", { name: "Disable loop" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await step("A new project opens with the brace over bar 1 and looping on");

    // 2. Start playback. The playhead runs to the end of bar 1 and jumps
    //    back to the start, over and over.
    await page.getByRole("button", { name: "Start playback" }).click();
    if (canAssertPlayback) {
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      // Two and a half bars of wall clock: long enough to contain at least
      // one turnaround at the end of bar 1, whenever in the bar it starts.
      const overBarOne = await watchPlayhead(page, 5_000);
      expect(overBarOne.map(barOf)).not.toContain(2);
      expect(turnedAround(overBarOne)).toBe(true);
      await step("Playback loops around the first bar");
    }

    // 3. Drag the right-hand edge of the brace out to the end of bar 2.
    const box = await timeline(page).boundingBox();
    if (!box) throw new Error("The arrangement timeline has no box to drag on.");
    const pixelsPerTick = Number(
      await page
        .getByTestId("arrangement-view-ready")
        .getAttribute("data-pixels-per-tick"),
    );
    expect(pixelsPerTick).toBeGreaterThan(0);
    // The flow never scrolls the arrangement, so a tick's x is its distance
    // from the timeline's left edge.
    const xOfBarLine = (bar: number) => box.x + (bar - 1) * TICKS_PER_BAR * pixelsPerTick;
    const rulerY = box.y + RULER_HEIGHT_PX / 2;

    await page.mouse.move(xOfBarLine(2), rulerY);
    await page.mouse.down();
    await page.mouse.move(xOfBarLine(3), rulerY, { steps: 12 });
    await page.mouse.up();

    // 4. The brace now spans two bars. Playback never stopped, and the
    //    playhead now turns around at the end of bar 2.
    await expect(loopBrace(page)).toContainText("bars 1 to 2");
    if (canAssertPlayback) {
      // The drag ran through a whole gesture without the transport being
      // touched: the button still offers to stop, so playback never stopped.
      await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
      // Three bars of wall clock over a two-bar loop: at least one
      // turnaround, and bar 3 must never be reached.
      const overTwoBars = await watchPlayhead(page, 6_000);
      expect(overTwoBars.map(barOf)).toContain(2);
      expect(overTwoBars.map(barOf)).not.toContain(3);
      expect(turnedAround(overTwoBars)).toBe(true);
    }
    await step("Drag the brace out to the end of bar 2 — playback never stopped");

    // 5. Switch looping off. The playhead runs past the end of the brace and
    //    keeps going; the brace stays where it is.
    await page.getByRole("button", { name: "Disable loop" }).click();
    await expect(page.getByRole("button", { name: "Enable loop" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    if (canAssertPlayback) {
      await expect
        .poll(async () => barOf(await playheadBeats(page)), { timeout: 20_000 })
        .toBeGreaterThanOrEqual(3);
    }
    // Switching the transport's behaviour left the range alone: that
    // separation is the whole point of the toggle being its own control.
    await expect(loopBrace(page)).toContainText("bars 1 to 2");
    await step("Looping off — the playhead runs past the brace, which stays put");

    // 6. Switch looping back on, stop, and reload the page.
    await page.getByRole("button", { name: "Enable loop" }).click();
    await expect(page.getByRole("button", { name: "Disable loop" })).toBeVisible();
    if (canAssertPlayback) {
      await page.getByRole("button", { name: "Stop playback" }).click();
      await expect(page.getByRole("button", { name: "Start playback" })).toBeVisible();
    }
    // Not a step of the flow: step 7's promise is only meaningful once the
    // change has actually been written, and the save status is how the editor
    // reports that a revision-checked write completed.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await step("Looping back on, and stopped");

    await reloadPage(page);

    // 7. The project reopens with the brace still spanning bars 1 and 2, and
    //    looping still on.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(loopBrace(page)).toContainText("bars 1 to 2");
    await expect(page.getByRole("button", { name: "Disable loop" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await step("Reopened: the brace and the toggle are exactly as they were left");
  });
});
