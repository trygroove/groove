import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-029`: a producer selects every clip in the arrangement with Cmd+A.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is the acceptance contract for #835, and it is
 * frozen once it lands: a later PR that changes an assertion here has to say
 * so in its body and justify it.
 *
 * It is `test.fixme` because none of this exists yet. Today `edit.select_all`
 * is registered for the `selection` (piano roll) context only, so in the
 * arrangement Cmd+A falls through to the browser and selects the page's text;
 * and Escape does not clear the arrangement's selection. The PR that closes
 * #835 removes this marker.
 *
 * What it holds #835 to, from the product owner's decisions (2026-10-01):
 *
 *  - **Cmd+A (Ctrl+A off macOS) selects every clip in the song**, on every
 *    track, and prevents the browser's select-all-text default. Playwright's
 *    `ControlOrMeta` presses the right one for the platform.
 *  - **It works with nothing selected**: step 5 presses it straight after
 *    Escape has emptied the selection.
 *  - **Escape clears the selection** once there is no surface open and no drag
 *    in flight.
 *  - **The result is one ordinary selection**, announced as a count, and Delete
 *    removes exactly those clips, whole.
 *
 * "No text on the page is highlighted" is read from `window.getSelection()`,
 * which is what the report in #835 measured (244 characters).
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

/** Click the middle of `bar` on row `rowIndex`. */
async function clickBar(page: Page, rowIndex: number, bar: number): Promise<void> {
  await timeline(page).click({ position: await barCentre(page, rowIndex, bar) });
}

/** Select the clip in `bar` on row `rowIndex` and duplicate it just after itself. */
async function duplicateClip(page: Page, rowIndex: number, bar: number): Promise<void> {
  await clickBar(page, rowIndex, bar);
  await page.keyboard.press("ControlOrMeta+D");
}

/** The page's text selection, as the report in #835 measured it. */
const selectedText = (page: Page): Promise<string> =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

/**
 * The state steps 6 and 8 both promise: both tracks are there and every bar
 * that held a clip is empty. A click in empty space sets a point at the bar's
 * start, so a clip left behind would be announced instead.
 */
async function expectNoClips(page: Page): Promise<void> {
  await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
  for (const [row, bars] of [
    [0, [1, 2, 3]],
    [1, [1, 2]],
  ] as const) {
    for (const bar of bars) {
      await clickBar(page, row, bar);
      await expect(announcement(page)).toHaveText(`Position ${bar}.1.1`);
    }
  }
}

test.describe("CF-029", () => {
  test("a producer selects every clip in the arrangement with Cmd+A", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-029",
      title: "A producer selects every clip in the arrangement with Cmd+A",
    });

    // 1. Create a new project, duplicate the "BD" clip twice, add a sampler
    //    track, and duplicate its clip once, so "BD" has clips in bars 1, 2
    //    and 3 and "Sampler" has clips in bars 1 and 2.
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
    await clickBar(page, 0, 3);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 3");
    await clickBar(page, 1, 2);
    await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 2");
    await step("BD has clips in bars 1 to 3, Sampler in bars 1 and 2");

    // 2. Click the "BD" clip in bar 1. It alone is selected, and the
    //    arrangement announces "Selected clip on BD, bar 1".
    await clickBar(page, 0, 1);
    await expect(announcement(page)).toHaveText("Selected clip on BD, bar 1");
    await step("Click the BD clip in bar 1: it alone is selected");

    // 3. Press Cmd+A (Ctrl+A on Windows and Linux). Every clip on both tracks
    //    is selected, and the arrangement announces "5 clips selected". No
    //    text on the page is highlighted.
    await page.keyboard.press("ControlOrMeta+A");
    await expect(announcement(page)).toHaveText("5 clips selected");
    expect(await selectedText(page)).toBe("");
    await step("Press Cmd+A: all five clips are selected");

    // 4. Press Escape. Nothing is selected, and the arrangement announces "No
    //    selection".
    await page.keyboard.press("Escape");
    await expect(announcement(page)).toHaveText("No selection");
    await step("Press Escape: nothing is selected");

    // 5. Press Cmd+A again. Every clip is selected again, the arrangement
    //    announces "5 clips selected", and no text on the page is highlighted.
    await page.keyboard.press("ControlOrMeta+A");
    await expect(announcement(page)).toHaveText("5 clips selected");
    expect(await selectedText(page)).toBe("");
    await step("Press Cmd+A with nothing selected: all five again");

    // 6. Press Delete. All five clips are gone. Both tracks are still there,
    //    empty.
    await page.keyboard.press("Delete");
    await expectNoClips(page);
    await step("Press Delete: every clip is gone, both tracks remain");

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
    //    are there, with no clips.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expectNoClips(page);
    await step("Reopened exactly as the delete left it");
  });
});
