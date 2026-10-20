import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import { backToArrangement, expectView, sequenceView } from "../support/views";

/**
 * `CF-016`: a producer Alt-drags clips to copy them.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is the acceptance contract for #456, and it is
 * frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * Alt-drag copy shipped with #456, and the "BD" pad lane with #496.
 *
 * **Revised for #817.** The sequence editor is a view on `2`, not a dialog over
 * the arrangement: opening a clip lands on it (`/sequence`), and `1` leaves it
 * instead of Escape. Parked at `test.fixme` until #817's stack lands; the PR
 * that closes #817 removes the marker.
 *
 * What it holds #456 to, from the product owner's decisions (2026-09-27):
 *
 *  - **Alt (Option on macOS) turns a body drag into a copy**, as in Ableton
 *    Live. Playwright's `Alt` is the Option key on macOS.
 *  - **It copies the whole selection**, each clip on its own track, keeping
 *    their spacing. Step 4 pins this: the Sampler copy in bar 5 only exists
 *    if the bar-3 Sampler clip was selected alongside the one pressed on.
 *  - **The copies are independent**: a fresh clip each, so an edit to one is
 *    not heard in the other (CLP-01's "independent" mode, not "linked").
 *  - **The copies become the selection**, which is what lets step 4 chain.
 *
 * The two clips are selected with a drag in empty space (CF-010), not with
 * Shift- or Cmd-click, so this flow does not wait on #405.
 *
 * Whether a clip is still there is read the way a screen-reader user would
 * find out: select it and listen (as in CF-010 and CF-015).
 */

/** Musical time at 192 PPQ in the alpha's fixed 4/4 (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/**
 * The interaction canvas the clips are drawn on. A class, deliberately: it is a
 * `<canvas>`, so it has no role or accessible name to reach it by, and a clip
 * can only be reached as a coordinate on it (see CF-004 and CF-008).
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

/** Click the middle of `bar` on row `rowIndex`. */
async function clickBar(page: Page, rowIndex: number, bar: number): Promise<void> {
  await timeline(page).click({ position: await barCentre(page, rowIndex, bar) });
}

/**
 * Press in the middle of one bar, drag to the middle of another, and release,
 * holding Alt throughout when `alt` is set. Alt goes down before the press and
 * up after the release, so the drop sees it held however it is read.
 */
async function dragBar(
  page: Page,
  from: { row: number; bar: number },
  to: { row: number; bar: number },
  alt = false,
): Promise<void> {
  const box = await timeline(page).boundingBox();
  if (!box) throw new Error("The arrangement timeline has no box to drag on.");
  const start = await barCentre(page, from.row, from.bar);
  const end = await barCentre(page, to.row, to.bar);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 12 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/**
 * Which bars hold a clip on each track, checked bar by bar from 1 to 5. A click
 * on a clip announces it; a click in empty space sets a point at the bar's
 * start, so a missing or extra clip is announced as the wrong thing.
 */
async function expectClipsIn(page: Page, bars: readonly number[]): Promise<void> {
  for (const [row, track] of [
    [0, "BD"],
    [1, "Sampler"],
  ] as const) {
    for (let bar = 1; bar <= 5; bar++) {
      await clickBar(page, row, bar);
      await expect(announcement(page)).toHaveText(
        bars.includes(bar)
          ? `Selected clip on ${track}, bar ${bar}`
          : `Position ${bar}.1.1`,
      );
    }
  }
}

/** Open the "BD" clip in `bar` and return the sequence view. */
async function openBdClip(page: Page, bar: number): Promise<Locator> {
  await timeline(page).dblclick({ position: await barCentre(page, 0, bar) });
  await expectView(page, "Sequence");
  await expect(sequenceView(page)).toBeVisible();
  return sequenceView(page);
}

/**
 * Step 2 of the "BD" pad in the "BD" track's clip in `bar`, read in its
 * editor. The starter is a drum machine (#496) whose kick pad "BD" is four on
 * the floor (steps 1, 5, 9, 13), so step 2 starts off in every copy.
 */
async function expectBdStepTwo(page: Page, bar: number, on: boolean): Promise<void> {
  const editor = await openBdClip(page, bar);
  await expect(
    editor.getByRole("button", { name: `BD, step 2, ${on ? "on" : "off"}` }),
  ).toBeVisible();
  await backToArrangement(page);
}

test.describe("CF-016", () => {
  test("a producer Alt-drags clips to copy them", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-016",
      title: "A producer Alt-drags clips to copy them",
    });

    // 1. Create a new project and add a sampler track, so "BD" and "Sampler"
    //    each have one clip, in bar 1.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();
    await page.getByRole("button", { name: "Add sampler track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await expectClipsIn(page, [1]);
    await step("BD and Sampler each have one clip, in bar 1");

    // 2. Press in the empty bar 2 on "BD" and drag down and back to the middle
    //    of bar 1 on "Sampler". Both clips in bar 1 are selected, and the
    //    arrangement announces "2 clips selected".
    await dragBar(page, { row: 0, bar: 2 }, { row: 1, bar: 1 });
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Drag across both tracks: both clips in bar 1 are selected");

    // 3. Hold Alt (Option on macOS), press on the "BD" clip in bar 1, drag it
    //    along to bar 3, and let go. Copies of both selected clips land in
    //    bar 3, one on each track. The clips in bar 1 have not moved, and
    //    bar 2 is still empty on both tracks. The copies are now the
    //    selection, and the arrangement announces "2 clips selected".
    //
    // Where each clip sits is checked after step 4, not here: checking means
    // clicking, and a click would replace the selection step 4 relies on.
    await dragBar(page, { row: 0, bar: 1 }, { row: 0, bar: 3 }, true);
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Alt-drag the BD clip to bar 3: both clips are copied");

    // 4. Hold Alt again, press on the "BD" clip in bar 3, and drag it along to
    //    bar 5. Copies of both clips from bar 3 land in bar 5, one on each
    //    track, so the copies made in step 3 were what was selected.
    //
    // Pressing on an unselected clip selects it alone (CF-009), so a Sampler
    // clip in bar 5 is only there if the bar-3 copies were the selection.
    await dragBar(page, { row: 0, bar: 3 }, { row: 0, bar: 5 }, true);
    await expect(announcement(page)).toHaveText("2 clips selected");
    await expectClipsIn(page, [1, 3, 5]);
    await step("Alt-drag again: the copies are copied to bar 5");

    // 5. Open the "BD" clip in bar 5. Turn on a step that was off on the "BD"
    //    pad, and press 1 to go back to the arrangement.
    const editor = await openBdClip(page, 5);
    await editor.getByRole("button", { name: "BD, step 2, off" }).click();
    await expect(editor.getByRole("button", { name: "BD, step 2, on" })).toBeVisible();
    await step("Turn on a step in the BD copy in bar 5");
    await backToArrangement(page);

    // 6. Open the "BD" clip in bar 1. The step you turned on in bar 5 is still
    //    off on the "BD" pad here. Press 1.
    await expectBdStepTwo(page, 1, false);
    await step("The BD clip in bar 1 is unchanged: the copy is independent");

    // 7. Reload the page.
    //
    // Not a step of the flow. The promise after the reload only means
    // something once the edits have been written, and the save status is how
    // the editor reports that a revision-checked write completed.
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);

    // 8. The project reopens exactly as step 6 left it: "BD" and "Sampler"
    //    each have clips in bars 1, 3 and 5, with bars 2 and 4 empty, and the
    //    step you turned on is on only in the "BD" clip in bar 5.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await expectClipsIn(page, [1, 3, 5]);
    await expectBdStepTwo(page, 1, false);
    await expectBdStepTwo(page, 3, false);
    await expectBdStepTwo(page, 5, true);
    await step("Reopened exactly as it was left");
  });
});
