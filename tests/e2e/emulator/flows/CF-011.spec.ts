import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-011`: a producer zooms in on what they selected.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments below are its
 * steps, in its words. This is one of the three acceptance contracts for #292
 * (one arrangement selection), and it is frozen once it lands: a later PR that
 * changes an assertion here has to say so in its body and justify it.
 *
 * It is `test.fixme` because `view.zoom_to_selection` reads only the shell's
 * one-track bar range today. A clicked placement leaves that range empty, so
 * zooming does nothing (the gap #292 names), and a drag cannot yet select
 * clips across tracks. The PR that closes #292 removes this marker.
 *
 * What it holds #292 to, from the product owner's decisions on the issue (the
 * whole-clip model revised on 2026-09-25): zoom to selection frames the
 * selected clips' extent, from the first one's start to the last one's end,
 * and a single clicked clip, from the toolbar button and from the `Z`
 * shortcut. A drag selects whole clips and its band does not persist, so there
 * is no dragged stretch left to frame. "Frames" is read off the arrangement
 * itself: the span of ticks the timeline shows is its scroll offset and its
 * width, both divided by the published horizontal scale.
 *
 * The drag in step 2 runs from halfway through bar 2 to halfway through bar 4,
 * so it starts halfway into a clip it only overlaps and ends half a bar past
 * the last clip it contains. Step 3 expects bars 2 to 3 exactly, the selected
 * clips and nothing else, so framing the dragged stretch instead of the clips
 * fails step 3 by half a bar at both edges. It starts in empty space because
 * pressing on a clip and dragging moves the clip.
 *
 * The drag is announced as "2 clips selected", with no position in it, and
 * the framed edges are the clips' bar lines, not where the pointer landed. So
 * its ends only have to sit clear of clip edges, which the middle of a bar
 * does. `EDGE_TOLERANCE_TICKS` allows for sub-pixel scroll rounding.
 */

/** One bar of the alpha's fixed 4/4 at 192 PPQ (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/**
 * How far a framed edge may sit from the position it frames: one sixteenth
 * note. That is loose enough for sub-pixel scroll rounding at any zoom this
 * flow reaches, and far tighter than the half-bar difference between framing
 * the selected clips and framing the stretch that was dragged over.
 */
const EDGE_TOLERANCE_TICKS = TICKS_PER_BAR / 16;

/**
 * The interaction canvas the clips are drawn on. A class, deliberately: it is a
 * `<canvas>`, so it has no role or accessible name to reach it by, and a clip
 * can only be clicked as a coordinate on it (see CF-004 and CF-008).
 */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/**
 * The arrangement's scroll container, whose width is the timeline's width and
 * whose `scrollLeft` is how far along the song the view has scrolled. A class
 * for the same reason as {@link timeline}: it is layout, with no role.
 */
const viewport = (page: Page): Locator => page.locator(".arrangement-viewport");

/** The arrangement's `aria-live` selection announcement (`ArrangementView`). */
const announcement = (page: Page): Locator =>
  page.getByTestId("arrangement-selection-live");

/** The arrangement's accessible mirror of the track list, top to bottom. */
const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

/** The timeline's horizontal scale, as the arrangement publishes it (CF-004). */
async function pixelsPerTick(page: Page): Promise<number> {
  const value = Number(
    await page.getByTestId("arrangement-view-ready").getAttribute("data-pixels-per-tick"),
  );
  expect(value).toBeGreaterThan(0);
  return value;
}

/** How far the timeline is scrolled along the song, in CSS pixels. */
const scrollLeft = (page: Page): Promise<number> =>
  viewport(page).evaluate((element) => element.scrollLeft);

/** The span of the song the timeline is showing, in ticks. */
async function visibleTicks(page: Page): Promise<{ start: number; end: number }> {
  const scale = await pixelsPerTick(page);
  const left = await scrollLeft(page);
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error("The arrangement viewport has no box to measure.");
  return { start: left / scale, end: (left + box.width) / scale };
}

/**
 * Assert the timeline shows exactly the stretch from `fromBarsIn` to
 * `toBarsIn` bars from the start of the song, edge to edge.
 */
async function expectFramed(
  page: Page,
  fromBarsIn: number,
  toBarsIn: number,
): Promise<void> {
  // The furthest either edge sits from the position it should frame. Polled,
  // because the scroll offset and the scale settle in separate frames.
  await expect
    .poll(async () => {
      const { start, end } = await visibleTicks(page);
      return Math.max(
        Math.abs(start - fromBarsIn * TICKS_PER_BAR),
        Math.abs(end - toBarsIn * TICKS_PER_BAR),
      );
    })
    .toBeLessThanOrEqual(EDGE_TOLERANCE_TICKS);
}

/**
 * The point in the middle of `bar` (1-based) on track row `rowIndex`, in the
 * timeline canvas's own coordinates, wherever the timeline is scrolled and
 * zoomed to. The vertical scale is read off the arrangement root (CF-008).
 */
async function barCentre(
  page: Page,
  rowIndex: number,
  bar: number,
): Promise<{ x: number; y: number }> {
  const root = page.getByTestId("arrangement-view-ready");
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(rowHeight).toBeGreaterThan(0);
  const scale = await pixelsPerTick(page);
  return {
    x: (bar - 0.5) * TICKS_PER_BAR * scale - (await scrollLeft(page)),
    y: rulerHeight + rowIndex * rowHeight + rowHeight / 2,
  };
}

/** Click the middle of `bar` on track row `rowIndex`. */
async function clickBar(page: Page, rowIndex: number, bar: number): Promise<void> {
  await timeline(page).click({ position: await barCentre(page, rowIndex, bar) });
}

/** Press in the middle of one bar and release in the middle of another. */
async function dragBetween(
  page: Page,
  from: { rowIndex: number; bar: number },
  to: { rowIndex: number; bar: number },
): Promise<void> {
  const box = await timeline(page).boundingBox();
  if (!box) throw new Error("The arrangement timeline has no box to drag on.");
  const start = await barCentre(page, from.rowIndex, from.bar);
  const end = await barCentre(page, to.rowIndex, to.bar);
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 12 });
  await page.mouse.up();
}

/** Select the clip in `bar` on row `rowIndex` and duplicate it just after itself. */
async function duplicateClip(page: Page, rowIndex: number, bar: number): Promise<void> {
  await clickBar(page, rowIndex, bar);
  await page.keyboard.press("ControlOrMeta+D");
}

test.describe("CF-011", () => {
  // `test.fixme` until #292 lands: the PR that closes it removes this marker in
  // the same diff that makes the flow pass.
  test("a producer zooms in on what they selected", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-011",
      title: "A producer zooms in on what they selected",
    });

    // 1. Create a new project, add a sampler track, and duplicate the
    //    sampler's clip twice, so "Sampler" has clips in bars 1, 2 and 3 and
    //    "BD" has its one clip in bar 1.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    const projectUrl = page.url();
    await page.getByTestId("arrangement-view-ready").waitFor();

    await page.getByRole("button", { name: "Add sampler track" }).click();
    await expect(trackList(page)).toHaveText(["BD", "Sampler"]);
    await duplicateClip(page, 1, 1);
    await duplicateClip(page, 1, 2);
    await clickBar(page, 1, 3);
    await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 3");
    // The new project's timeline starts wider than the three bars this flow
    // zooms into. Otherwise step 3 would not have to change anything.
    const before = await visibleTicks(page);
    expect(before.end - before.start).toBeGreaterThan(3 * TICKS_PER_BAR);
    await step("BD has one clip in bar 1, and Sampler has clips in bars 1 to 3");

    // 2. Press halfway through the empty bar 2 on "BD" and drag down and
    //    along to halfway through bar 4 on "Sampler". The sampler's clips in
    //    bars 2 and 3, which the drag overlaps and wholly contains, are
    //    selected as whole clips, and the arrangement announces "2 clips
    //    selected".
    await dragBetween(page, { rowIndex: 0, bar: 2 }, { rowIndex: 1, bar: 4 });
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Drag from mid bar 2 on BD to mid bar 4 on Sampler: two clips selected");

    // 3. Zoom to selection from the toolbar. The timeline now shows exactly the
    //    selected clips and nothing else: the start of bar 2 at its left edge
    //    and the end of bar 3 at its right edge. The half bars you dragged
    //    over either side of them are not framed.
    await page.getByRole("button", { name: "Zoom to selection" }).click();
    await expectFramed(page, 1, 3);
    // Zooming is a view change, not a selection change.
    await expect(announcement(page)).toHaveText("2 clips selected");
    await step("Zoom to selection: the selected clips, bars 2 to 3, fill the timeline");

    // 4. Click the sampler's clip in bar 3 and press Z. Bar 3 alone now fills
    //    the timeline, edge to edge.
    await clickBar(page, 1, 3);
    await expect(announcement(page)).toHaveText("Selected clip on Sampler, bar 3");
    await page.keyboard.press("z");
    // A clicked clip selects its own span, bar line to bar line.
    await expectFramed(page, 2, 3);
    await step("Click the clip in bar 3 and press Z: bar 3 fills the timeline");

    // 5. Reload the page.
    //
    // Not a step of the flow. The duplicates from step 1 are what the reopened
    // project has to show, and the save status is how the editor reports that
    // the write completed.
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);

    // 6. The project reopens with nothing selected, so zoom to selection has
    //    nothing to act on until you select something again.
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(announcement(page)).toHaveText("No selection");
    await expect(page.getByRole("button", { name: "Zoom to selection" })).toBeDisabled();
    await step("Reopened with nothing selected, so there is nothing to zoom to");
  });
});
