import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-015`: a producer picks out several clips with the keyboard held down.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is the acceptance contract for #405, and it is
 * frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * It is `test.fixme` because none of this exists yet. Today a click on a clip
 * replaces the selection whatever modifier is held, so the arrangement can only
 * hold several clips at once through a drag in empty space (CF-010). The PR
 * that closes #405 removes this marker.
 *
 * What it holds #405 to, from the product owner's decisions (2026-09-27):
 *
 *  - **Cmd-click (Ctrl-click off macOS) toggles one clip** in or out of the
 *    selection and keeps the rest. Playwright's `ControlOrMeta` presses the
 *    right one for the platform the browser runs on.
 *  - **Shift-click extends the selection to a box**: every clip on every track
 *    between the selection and the clicked clip, over the time from the
 *    earliest start to the latest end among them. From the "BD" clip in bar 3
 *    to the "Sampler" clip in bar 2 that is bars 2 to 3 on both tracks, so the
 *    clips in bar 1 stay out. No anchor is remembered beyond the selection
 *    itself, which is why step 4 leaves only bar 3 selected first.
 *  - **The result is one ordinary selection**, announced as a count like a
 *    drag's, and Delete removes exactly those clips, whole.
 *
 * Whether a clip is still there is read the way a screen-reader user would
 * find out: select it and listen (as in CF-010).
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

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
 * The middle of `bar` (1-based) on track row `rowIndex`, in the timeline
 * canvas's own coordinates. Both scales are read off the arrangement root,
 * never copied (CF-004, CF-008). The flow never scrolls or zooms.
 */
async function barCentre(
  page: Page,
  rowIndex: number,
  bar: number,
): Promise<{ x: number; y: number }> {
  const root = page.getByTestId("arrangement-view-ready");
  const pixelsPerTick = Number(await root.getAttribute("data-pixels-per-tick"));
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(pixelsPerTick).toBeGreaterThan(0);
  expect(rowHeight).toBeGreaterThan(0);
  return {
    x: (bar - 0.5) * TICKS_PER_BAR * pixelsPerTick,
    y: rulerHeight + rowIndex * rowHeight + rowHeight / 2,
  };
}

type Modifier = "ControlOrMeta" | "Shift";

/** Click the middle of `bar` on row `rowIndex`, holding `modifier` if given. */
async function clickBar(
  page: Page,
  rowIndex: number,
  bar: number,
  modifier?: Modifier,
): Promise<void> {
  await timeline(page).click({
    position: await barCentre(page, rowIndex, bar),
    modifiers: modifier ? [modifier] : [],
  });
}

/** Select the clip in `bar` on row `rowIndex` and duplicate it just after itself. */
async function duplicateClip(page: Page, rowIndex: number, bar: number): Promise<void> {
  await clickBar(page, rowIndex, bar);
  await page.keyboard.press("ControlOrMeta+D");
}

/**
 * The state steps 6 and 8 both promise: the clips in bar 1 are still there on
 * both tracks, and bars 2 and 3 are empty on both. A click in empty space sets
 * a point at the bar's start, so a clip left behind would be announced instead.
 */
async function expectOnlyBarOne(page: Page): Promise<void> {
  await clickBar(page, 0, 1);
  await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
  await clickBar(page, 1, 1);
  await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 1");
  for (const row of [0, 1]) {
    for (const bar of [2, 3]) {
      await clickBar(page, row, bar);
      await expect(announcement(page)).toHaveText(`Position ${bar}.1.1`);
    }
  }
}

test.describe("CF-015", () => {
  test("a producer picks out several clips with the keyboard held down", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-015",
      title: "A producer picks out several clips with the keyboard held down",
    });

    // 1. Create a new project, duplicate the "BD" clip twice, add a sampler
    //    track, and duplicate its clip twice, so "BD" and "Sampler" each
    //    have clips in bars 1, 2 and 3.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await duplicateClip(page, 0, 1);
    await duplicateClip(page, 0, 2);
    await page.getByRole("button", { name: "Add sampler track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await duplicateClip(page, 1, 1);
    await duplicateClip(page, 1, 2);
    await clickBar(page, 0, 3);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 3");
    await clickBar(page, 1, 3);
    await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 3");
    await step("BD and Sampler each have clips in bars 1, 2 and 3");

    // 2. Click the "BD" clip in bar 1. It alone is selected, and the
    //    arrangement announces "Selected clip on BD, bar 1".
    await clickBar(page, 0, 1);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
    await step("Click the BD clip in bar 1: it alone is selected");

    // 3. Hold Cmd (Ctrl on Windows and Linux) and click the "BD" clip in
    //    bar 3. It joins the selection without replacing it, and the
    //    arrangement announces "2 clips selected". The "BD" clip in bar 2,
    //    between them, is not selected.
    await clickBar(page, 0, 3, "ControlOrMeta");
    // Two, not three: Cmd-click adds one clip, it does not fill the gap.
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Cmd-click the BD clip in bar 3: it joins the selection");

    // 4. Hold Cmd and click the "BD" clip in bar 1 again. It leaves the
    //    selection, and the arrangement announces "Selected clip on BD,
    //    bar 3".
    await clickBar(page, 0, 1, "ControlOrMeta");
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 3");
    await step("Cmd-click the BD clip in bar 1 again: it leaves the selection");

    // 5. Hold Shift and click the "Sampler" clip in bar 2. The selection
    //    grows to every clip in the box from what was selected to the clip
    //    you clicked, across both tracks: the clips in bars 2 and 3 on "BD"
    //    and on "Sampler". The arrangement announces "4 clips selected". The
    //    clips in bar 1 on both tracks are not selected.
    await clickBar(page, 1, 2, "Shift");
    // Four, not six: the box runs from bar 2 to bar 3, so bar 1 stays out.
    await expect(announcement(page)).toHaveText("4 clips selected");
    await step("Shift-click the Sampler clip in bar 2: bars 2 and 3 on both tracks");

    // 6. Press Delete. The four selected clips are gone, whole, and the
    //    clips in bar 1 on both tracks are untouched.
    await page.keyboard.press("Delete");
    await expectOnlyBarOne(page);
    await step("Press Delete: the four clips are gone; bar 1 is untouched");

    // 7. Reload the page.
    //
    // Not a step of the flow. The promise after the reload only means
    // something once the delete has been written, and the save status is
    // how the editor reports that a revision-checked write completed.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);

    // 8. The project reopens exactly as step 6 left it: "BD" and "Sampler"
    //    each have only their clip in bar 1, and nothing is selected.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await expect(announcement(page)).toHaveText("No selection");
    await expectOnlyBarOne(page);
    await step("Reopened exactly as the delete left it");
  });
});
