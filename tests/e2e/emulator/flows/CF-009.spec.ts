import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-009`: a producer clicks a clip and is told which one it is.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #292
 * (one arrangement selection), and it is frozen once it lands: a later PR that
 * changes an assertion here has to say so in its body and justify it.
 *
 * It is `test.fixme` because the arrangement still has two selections. Clicking
 * a placement today sets `placementEditingController`'s ID set and says nothing
 * to the `aria-live` mirror, which only ever reads the shell's one-bar range.
 * None of the announcements below exists yet. The PR that closes #292 removes
 * this marker.
 *
 * What it holds #292 to, from the product owner's decisions on the issue (the
 * whole-clip model revised on 2026-09-25):
 *
 *  - **A clip is announced with its whole bars.** Clips snap to bars, so one
 *    clip reads "Selected clip on {track}, bar N" (or "bars N to M").
 *  - **A click in empty space sets a point at the start of the bar clicked
 *    in**, announced as "Position {bar}.1.1". Step 3 aims halfway through
 *    bar 3, as far from either bar line as it can be, so only a point that
 *    snaps to the bar's start is announced "Position 3.1.1".
 *  - **A drag selects whole clips, and one that touches no clip selects
 *    nothing**: "No selection". The band it draws does not persist, and there
 *    is no range selection left to announce.
 *  - **One selection, not two.** A point, or a drag that selects nothing,
 *    replaces the clip selection instead of sitting beside it.
 *
 * Step 4's drag stays inside bar 3, two bars clear of the only clip, so which
 * pixel either end lands on cannot make it touch the clip. Its ends are still
 * aimed a quarter of the way into a sixteenth, as the flow words them.
 *
 * The drag band's dotted outline and a selected clip's solid one are canvas
 * pixels, so this spec can only show them in the walkthrough.
 * `canvasRenderer.test.ts` is where #292 asserts the two strokes differ.
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

/**
 * The interaction canvas the clips are drawn on. A class, deliberately: it is a
 * `<canvas>`, so it has no role or accessible name to reach it by, and a clip
 * can only be clicked as a coordinate on it (see CF-004 and CF-008).
 */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The arrangement's `aria-live` selection announcement (`ArrangementView`). */
const announcement = (page: Page): Locator =>
  page.getByTestId("arrangement-selection-live");

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

/** The middle of `bar` (1-based), in ticks: half a bar from either bar line. */
const midBar = (bar: number): number => (bar - 0.5) * TICKS_PER_BAR;

/** Click the middle of the one-bar clip in `bar` on row `rowIndex`. */
const clickClip = (page: Page, rowIndex: number, bar: number) =>
  clickAt(page, rowIndex, midBar(bar));

/** Press at `fromTicks` on row `rowIndex`, drag along it to `toTicks`, release. */
async function dragAlong(
  page: Page,
  rowIndex: number,
  fromTicks: number,
  toTicks: number,
): Promise<void> {
  const box = await timeline(page).boundingBox();
  if (!box) throw new Error("The arrangement timeline has no box to drag on.");
  const start = await pointAt(page, rowIndex, fromTicks);
  const end = await pointAt(page, rowIndex, toTicks);
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 12 });
  await page.mouse.up();
}

test.describe("CF-009", () => {
  // `test.fixme` until #292 lands: the PR that closes it removes this marker in
  // the same diff that makes the flow pass.
  test("a producer clicks a clip and is told which one it is", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-009",
      title: "A producer clicks a clip and is told which one it is",
    });

    // 1. Create a new project. The starter clip sits on the "BD" track in
    //    bar 1, and nothing is selected.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await expect(
      page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem"),
    ).toHaveText(["BD"]);
    await expect(announcement(page)).toHaveText("No selection");
    await step("A new project opens with the starter clip on BD and nothing selected");

    // 2. Click the clip. It gets a solid outline, and the arrangement
    //    announces "Selected clip on BD, bar 1".
    await clickClip(page, 0, 1);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
    await step("Click the clip: it is outlined and announced as a clip");

    // 3. Click the empty space halfway through bar 3 on the same track. The
    //    clip's outline goes away, a cursor marks the start of the bar you
    //    clicked in, and the arrangement announces "Position 3.1.1".
    await clickAt(page, 0, midBar(3));
    await expect(announcement(page)).toHaveText("Position 3.1.1");
    await step("Click mid bar 3: the clip is deselected and a point set at 3.1.1");

    // 4. Drag along the same track from the second sixteenth of bar 3 to its
    //    last sixteenth. A dotted outline follows the pointer while you drag.
    //    It touches no clip, so when you let go nothing is selected, and the
    //    arrangement announces "No selection".
    await dragAlong(page, 0, insideSixteenth(3, 1, 2), insideSixteenth(3, 4, 4));
    await expect(announcement(page)).toHaveText("No selection");
    await step("Drag over empty space touching no clip: nothing is selected");

    // 5. Click the clip again, then reload the page.
    await clickClip(page, 0, 1);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
    // Not a step of the flow. Nothing here edits the project: the dashboard
    // wrote it before opening it, and a selection is never saved. So the save
    // status stays idle (an empty label), and waiting for "Saved" would wait
    // for a save that never comes. What the reload needs is only that no write
    // is still in flight, which is what this waits for.
    await expect(page.locator(".save-status")).not.toHaveAttribute(
      "data-state",
      /^(pending|saving|failed)$/,
      { timeout: 10_000 },
    );
    await reloadPage(page);

    // 6. The project reopens with nothing selected. Clicking the clip selects
    //    it and announces it exactly as before.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(announcement(page)).toHaveText("No selection");
    await step("Reopened: the clip is where it was, and nothing is selected");

    await clickClip(page, 0, 1);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
    await step("Clicking the clip selects and announces it just as before");
  });
});
