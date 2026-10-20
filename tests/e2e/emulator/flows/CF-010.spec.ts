import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-010`: a producer drags across tracks to select clips and deletes them.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #292
 * (one arrangement selection), and it is frozen once it lands: a later PR that
 * changes an assertion here has to say so in its body and justify it.
 *
 * It is `test.fixme` because none of this exists yet. Today a press on empty
 * space selects one bar on one track, a drag does not extend it, a bar range
 * never selects the placements under it, and Delete acts only on
 * `placementEditingController`'s own ID set. The PR that closes #292 removes
 * this marker.
 *
 * What it holds #292 to, from the product owner's decisions on the issue (the
 * whole-clip model revised on 2026-09-25):
 *
 *  - **A drag can cross more than one track**, and on release it selects every
 *    clip it wholly contains or overlaps, as whole clips. The band itself does
 *    not persist.
 *  - **Several selected clips are announced as a count**: "{n} clips selected".
 *  - **Delete removes the selected clips, whole.** Nothing is trimmed: the
 *    Sampler clip the drag only overlapped goes entirely, not just the part the
 *    drag covered. Nothing unselected is touched, and the result survives a
 *    reload.
 *  - **A drag that touches no clip selects nothing**: "No selection". The spec
 *    repeats step 2's drag after the delete to show that stretch is empty.
 *  - **A click in empty space sets a point at the start of the bar clicked
 *    in**: "Position {bar}.1.1". The spec clicks where the Sampler clip began to
 *    show that no trimmed remainder of it is left there.
 *
 * The drag starts in empty space because pressing on a clip and dragging moves
 * the clip. Neither end of it is announced any more, so its ends only have to
 * sit clear of clip edges. They are aimed a quarter of the way into the 2.3.1
 * and 4.3.1 sixteenths, as the flow words them, half a bar from the nearest
 * bar line, where the pointer landing on a whole pixel (about 7 ticks at the
 * opening zoom) cannot change which clips the drag touches.
 *
 * Step 1 moves one clip by its body and drags another's right edge out. Since
 * #493 that edge drag tiles linked copies a bar at a time rather than
 * lengthening the clip, so "Sampler" gets one-bar clips in bars 1 and 2 and the
 * clip the step 2 drag overlaps is the one in bar 2.
 *
 * The register says "one clip across bars 1 to 3"; this spec differs (#493),
 * and the assertions that follow from it are marked "#493" below.
 *
 * Whether a clip is still there is read the way a screen-reader user would
 * find out: select it and listen.
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_SIXTEENTH = 48;
const TICKS_PER_BEAT = 4 * TICKS_PER_SIXTEENTH;
const TICKS_PER_BAR = 4 * TICKS_PER_BEAT;

/**
 * The tick a quarter of the way into sixteenth `bar.beat.sixteenth` (all
 * 1-based, as the flow names them). See the note above.
 */
const insideSixteenth = (bar: number, beat: number, sixteenth: number): number =>
  (bar - 1) * TICKS_PER_BAR +
  (beat - 1) * TICKS_PER_BEAT +
  (sixteenth - 1) * TICKS_PER_SIXTEENTH +
  TICKS_PER_SIXTEENTH / 4;

/** The middle of `bar` (1-based), in ticks: where a one-bar clip is clicked. */
const midBar = (bar: number): number => (bar - 0.5) * TICKS_PER_BAR;

/**
 * The interaction canvas the clips are drawn on. A class, deliberately: it is a
 * `<canvas>`, so it has no role or accessible name to reach it by, and a clip
 * can only be clicked as a coordinate on it (see CF-004 and CF-008).
 */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The arrangement's `aria-live` selection announcement (`ArrangementView`). */
const announcement = (page: Page): Locator =>
  page.getByTestId("arrangement-selection-live");

/** The arrangement's accessible mirror of the track list, top to bottom. */
const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

/**
 * The point at `ticks` on track row `rowIndex`, in the timeline canvas's own
 * coordinates.
 *
 * Both scales are read off the arrangement root, never copied: the horizontal
 * one is `data-pixels-per-tick` (CF-004) and the vertical one is
 * `data-ruler-height`/`data-row-height` (CF-008). The flow never scrolls or
 * zooms, so a tick's x is its distance from the canvas's left edge.
 */
async function pointAt(
  page: Page,
  rowIndex: number,
  ticks: number,
): Promise<{ x: number; y: number }> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  return {
    x: ticks * pixelsPerTick,
    y: rulerHeight + rowIndex * rowHeight + rowHeight / 2,
  };
}

/** Click at `ticks` on track row `rowIndex`. */
async function clickAt(page: Page, rowIndex: number, ticks: number): Promise<void> {
  await timeline(page).click({ position: await pointAt(page, rowIndex, ticks) });
}

/** Press at one canvas point, drag to another, and release. */
async function drag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const box = await timeline(page).boundingBox();
  if (!box) throw new Error("The arrangement timeline has no box to drag on.");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 12 });
  await page.mouse.up();
}

/** Step 2's drag: from 2.3.1 on "BD" down and along to 4.3.1 on "Sampler". */
async function dragAcrossBothTracks(page: Page): Promise<void> {
  await drag(
    page,
    await pointAt(page, 0, insideSixteenth(2, 3, 1)),
    await pointAt(page, 1, insideSixteenth(4, 3, 1)),
  );
}

/**
 * The state steps 3 and 5 both promise.
 *
 *  - The "BD" clip in bar 1 is still there, and still one bar long.
 *  - The "Sampler" clip in bar 1 is still there too (#493: it was the whole
 *    lengthened clip, and is now the source the edge drag repeated).
 *  - Nothing is left in bar 2 on "Sampler", where the overlapped clip started.
 *    A click there is a click in empty space, so it sets a point at the bar's
 *    start. A clip trimmed to the part the drag did not cover would still be
 *    here, and would be announced as a clip instead.
 *  - Step 2's drag now touches no clip on either track, so it selects nothing.
 *    That shows the "BD" clip in bar 3 and the rest of the "Sampler" clip are
 *    gone too.
 */
async function expectAfterDelete(page: Page): Promise<void> {
  await clickAt(page, 0, midBar(1));
  await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
  await clickAt(page, 1, midBar(1));
  await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 1");
  await clickAt(page, 1, midBar(2));
  await expect(announcement(page)).toHaveText("Position 2.1.1");
  await dragAcrossBothTracks(page);
  await expect(announcement(page)).toHaveText("No selection");
}

test.describe("CF-010", () => {
  // `test.fixme` until #292 lands: the PR that closes it removes this marker in
  // the same diff that makes the flow pass.
  test("a producer drags across tracks to select clips and deletes them", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-010",
      title: "A producer drags across tracks to select clips and deletes them",
    });

    // 1. Create a new project, duplicate the "BD" clip, and drag the copy
    //    along to bar 3, so "BD" has a clip in bar 1 and another in bar 3
    //    with bar 2 empty between them. Add a sampler track and drag the
    //    right edge of its clip out to the end of bar 3, so "Sampler" has one
    //    clip across bars 1 to 3.
    //    #493: an edge drag now tiles linked copies, so it ends at the end
    //    of bar 2 and "Sampler" has clips in bars 1 and 2.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await clickAt(page, 0, midBar(1));
    await page.keyboard.press("ControlOrMeta+D");
    // Pressing on a clip's body and dragging moves it, a bar at a time.
    await drag(
      page,
      await pointAt(page, 0, midBar(2)),
      await pointAt(page, 0, midBar(3)),
    );

    await page.getByRole("button", { name: "Add sampler track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    // One pixel inside the clip's right edge, which is its resize handle.
    const rightEdge = await pointAt(page, 1, TICKS_PER_BAR);
    await drag(
      page,
      { ...rightEdge, x: rightEdge.x - 1 },
      await pointAt(page, 1, 2 * TICKS_PER_BAR),
    );

    await clickAt(page, 0, midBar(3));
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 3");
    await clickAt(page, 1, midBar(2));
    // #493: was "bars 1 to 3", one lengthened clip.
    await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 2");
    await step("BD has clips in bars 1 and 3; Sampler has clips in bars 1 and 2");

    // 2. Press in the empty bar 2 on "BD", at 2.3.1, and drag down and along
    //    to 4.3.1 on "Sampler". A dotted outline follows the pointer across
    //    both tracks. When you let go it goes away, and the clips it touched
    //    are selected as whole clips: the "BD" clip in bar 3, which it wholly
    //    contained, and the "Sampler" clip, which it overlapped. Each gets a
    //    solid outline, and the arrangement announces "2 clips selected". The
    //    "BD" clip in bar 1 is not selected.
    await dragAcrossBothTracks(page);
    // Two: the BD clip in bar 3 and the overlapped Sampler clip. Not three,
    // because the BD clip in bar 1 ends before the drag begins.
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Drag across both tracks: the two clips it touches are selected, whole");

    // 3. Press Delete. Both selected clips are gone, whole: nothing is
    //    trimmed. The "BD" clip in bar 1 is untouched. Clicking in bar 1 on
    //    "Sampler", where its clip started, finds empty space and announces
    //    "Position 1.1.1". The same drag as in step 2 now touches no clip,
    //    and is announced as "No selection".
    await page.keyboard.press("Delete");
    await expectAfterDelete(page);
    await step("Press Delete: both clips are gone, whole; the bar 1 clips are untouched");

    // 4. Reload the page.
    //
    // Not a step of the flow. The promise after the reload only means
    // something once the delete has been written, and the save status is how
    // the editor reports that a revision-checked write completed.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);

    // 5. The project reopens exactly as step 3 left it: both tracks are
    //    still there, "BD" has only its clip in bar 1, and "Sampler" has no
    //    clips.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await expectAfterDelete(page);
    await step("Reopened exactly as the delete left it");
  });
});
