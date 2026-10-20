import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";
import {
  dock,
  dockTile,
  emptyScreen,
  expectView,
  pressView,
  sequenceView,
} from "../support/views";

/**
 * `CF-008` — a producer moves between the five views by dock and by keyboard.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. It was the acceptance contract for `UI-001` (#304), and
 * is **rewritten for #817**, which puts five views on `1`–`5`: Arrangement,
 * Sequence, Instrument, Library, Mixer. It is frozen once it lands: a later PR
 * that changes an assertion here has to say so in its body and justify it.
 *
 * `test.fixme` until #817's stack lands; the PR that closes #817 removes this
 * marker. What is missing today:
 *
 *  - **Sequence is a modal**, a dialog over the arrangement opened from a clip,
 *    with no key and no address. #817 makes it the view on `2`, with an empty
 *    screen when no clip is selected.
 *  - **The dock has three labelled links** and the instrument and mixer sit on
 *    `2` and `3`. #817 draws five icon tiles with their keys, moves the
 *    instrument to `3` and the mixer to `5`, and gives each tile a hover tip.
 *  - **The mixer does not say where you came from.** #817's `5` lands with the
 *    track you came from marked.
 *
 * Every locator #817 introduces is assumed, and listed in `../support/views.ts`.
 * The tiles carry no visible label, so the view you are on is read by
 * accessible name, never by text.
 *
 * Runs against the Firestore/Auth emulator, like every core flow: step 9 is a
 * real `page.reload()`, and the mock backend is a fresh, empty store on every
 * page load.
 *
 * ---
 *
 * **Why this flow moves by keyboard *and* by dock.** Two entrypoints that reach
 * different states is the classic way a switcher rots. Steps 2 and 4-7 use
 * keys, step 8 the dock and the back button, and every one of them asserts the
 * dock's current-view marker through `expectView`, so the paths are held to the
 * same state by construction.
 */

/** One bar of the alpha's fixed 4/4 at 192 PPQ (`src/domain/time.ts`). */
const TICKS_PER_BAR = 4 * 192;

/**
 * The vertical middle of one track row, in the timeline canvas's coordinates.
 * Read off the arrangement root rather than written down here, so a change of
 * row height cannot leave a stale copy passing.
 */
const rowCentreY = async (page: Page, rowIndex: number): Promise<number> => {
  const root = page.getByTestId("arrangement-view-ready");
  const rulerHeight = Number(await root.getAttribute("data-ruler-height"));
  const rowHeight = Number(await root.getAttribute("data-row-height"));
  expect(rowHeight).toBeGreaterThan(0);
  return rulerHeight + rowIndex * rowHeight + rowHeight / 2;
};

/**
 * The interaction canvas the tracks are drawn on. A class, deliberately: it is
 * a `<canvas>`, so there is no role or accessible name to reach it by, and the
 * gesture that opens a clip is a coordinate on it (see CF-005 and CF-007).
 */
const timeline = (page: Page): Locator => page.locator(".arrangement-layer-interactive");

/** The instrument view's track rail, down the left edge. */
const trackRail = (page: Page): Locator => page.getByRole("list", { name: "Tracks" });

/** The arrangement's accessible mirror of the track list, top to bottom. */
const trackList = (page: Page): Locator =>
  page.getByRole("list", { name: "Arrangement tracks" }).getByRole("listitem");

/** A view fills the page: seven tenths of each axis is a floor, not a target. */
async function expectFillsPage(page: Page, region: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await region.boundingBox();
  if (!viewport || !box) throw new Error("This spec needs a sized view to measure.");
  expect(box.width).toBeGreaterThan(viewport.width * 0.7);
  expect(box.height).toBeGreaterThan(viewport.height * 0.7);
}

// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("CF-008", { tag: "@sanity" }, () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test(
    "a producer moves between the five views by dock and by keyboard",
    async ({ page }) => {
      const step = walkthrough(page, {
        id: "CF-008",
        title: "A producer moves between the five views by dock and by keyboard",
      });

      // 1. Create a new project. It opens on the arrangement, which fills the
      //    page, with the starter pattern on the only track ("BD", a drum
      //    machine) and a dock floating along the bottom: five square tiles
      //    numbered 1 to 5, with the arrangement's marked as the view you are on.
      await page.goto("/projects");
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
      await page.getByRole("button", { name: "New Project" }).click();
      await expectView(page, "Arrangement");
      const arrangementUrl = page.url();
      await page.getByTestId("arrangement-view-ready").waitFor();
      await expect(trackList(page)).toHaveCount(1);
      const trackName = ((await trackList(page).first().textContent()) ?? "").trim();
      expect(trackName).toBe("BD");

      // Five tiles, in key order, each showing its key: the dock is the number
      // row drawn on screen.
      const tiles = dock(page).getByRole("link");
      await expect(tiles).toHaveCount(5);
      const names = [
        "Arrangement",
        "Sequence",
        "Instrument",
        "Library",
        "Mixer",
      ] as const;
      for (const [index, name] of names.entries()) {
        await expect(tiles.nth(index)).toHaveAccessibleName(name);
        await expect(tiles.nth(index)).toContainText(String(index + 1));
      }
      await expect(page.getByRole("region", { name: "Library" })).toHaveCount(0);
      await expect(sequenceView(page)).toHaveCount(0);
      await step("A new project opens on the arrangement, five tiles in the dock");

      // 2. Press 2 before choosing a clip. The sequence view says no clip is
      //    selected, tells you to select one in the arrangement, and offers a
      //    button back to the arrangement that shows its key, 1. Press that
      //    button. You are back on the arrangement.
      await pressView(page, "Sequence");
      const noClip = emptyScreen(page, "No clip selected");
      await expect(noClip).toBeVisible();
      await expect(noClip).toContainText(
        "Select a clip in the arrangement, then press 2 to edit its steps or notes.",
      );
      const fix = noClip.getByRole("button", { name: /Arrangement/ });
      await expect(fix).toContainText("1");
      await step("Press 2 with no clip: the view says what is missing");

      await fix.click();
      await expectView(page, "Arrangement");
      await page.getByTestId("arrangement-view-ready").waitFor();

      // 3. Point at the dock's second tile. Its tip names the view, its key and
      //    what it will open; with no clip chosen it names no clip.
      await dockTile(page, "Sequence").hover();
      const tip = page.getByRole("tooltip");
      await expect(tip).toContainText("2");
      await expect(tip).toContainText("Sequence");
      await expect(tip).not.toContainText("Four on the floor");
      await step("Point at the second tile: its tip names the view and key");

      // 4. Open the clip on the timeline. The sequence view fills the page,
      //    showing the four-on-the-floor pattern on the "BD" pad, and the dock
      //    marks the sequence view as the one you are on.
      const pixelsPerTick = Number(
        await page
          .getByTestId("arrangement-view-ready")
          .getAttribute("data-pixels-per-tick"),
      );
      expect(pixelsPerTick).toBeGreaterThan(0);
      await timeline(page).dblclick({
        position: {
          x: (TICKS_PER_BAR / 2) * pixelsPerTick,
          y: await rowCentreY(page, 0),
        },
      });
      await expectView(page, "Sequence");
      await expect(sequenceView(page)).toBeVisible();
      // Steps 1, 5, 9 and 13 on (#496). Two of them, plus an off step, so this
      // cannot pass against an empty grid — the same guard CF-001 carries.
      const editor = sequenceView(page);
      await expect(editor.getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
      await expect(editor.getByRole("button", { name: "BD, step 5, on" })).toBeVisible();
      await expect(editor.getByRole("button", { name: "BD, step 2, off" })).toBeVisible();
      await expectFillsPage(page, editor);
      // One job at a time: the timeline is not behind the sequence view, it is
      // not on the page.
      await expect(page.getByTestId("arrangement-view-ready")).toHaveCount(0);
      await step("Open the clip: the sequence view fills the page");

      // 5. Turn on a step that was off on the "BD" pad, then press 1. The
      //    arrangement is exactly as it was apart from the edit.
      await editor.getByRole("button", { name: "BD, step 2, off" }).click();
      await expect(editor.getByRole("button", { name: "BD, step 2, on" })).toBeVisible();
      await step("Turn on a step that was off");

      await pressView(page, "Arrangement");
      await expect(page).toHaveURL(arrangementUrl);
      await page.getByTestId("arrangement-view-ready").waitFor();
      await expect(trackList(page)).toHaveCount(1);
      await step("Press 1: the arrangement, unchanged");

      // 6. Press 3. The track's instrument fills the page, with a list of the
      //    project's tracks down the left edge and the dock marking the
      //    instrument view.
      await pressView(page, "Instrument");
      await expect(
        page.getByRole("region", { name: `${trackName} instrument` }),
      ).toBeVisible();
      await expect(trackRail(page).getByRole("listitem")).toHaveCount(1);
      await expect(trackRail(page)).toContainText(trackName);
      await expect(page.getByTestId("arrangement-view-ready")).toHaveCount(0);
      await step("Press 3: the instrument fills the page, tracks down the left");

      // 7. Press 5. The mixer fills the page with the "BD" track's strip marked
      //    as the one you came from. Pull its volume fader down.
      await pressView(page, "Mixer");
      const mixerUrl = page.url();
      await expect(page.getByRole("region", { name: "Mixer" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: `Edit ${trackName}` }),
      ).toHaveAttribute("aria-pressed", "true");

      // The fader travels in its own normalized position, not in decibels
      // (`src/domain/faders.ts`); 0.4 is simply somewhere below where a new
      // track starts.
      const fader = page.getByRole("slider", { name: `Volume for ${trackName}` });
      const restingVolume = Number(await fader.inputValue());
      await fader.fill("0.4");
      await expect(fader).toHaveValue("0.4");
      expect(restingVolume).toBeGreaterThan(0.4);
      await step("Press 5: pull the track's fader down in the mixer");

      // 8. Go back to the arrangement from the dock. The timeline is as you left
      //    it, and the dock marks the arrangement as the view you are on. Press
      //    the browser's back button: you are on the mixer again.
      await dockTile(page, "Arrangement").click();
      await expectView(page, "Arrangement");
      await page.getByTestId("arrangement-view-ready").waitFor();
      await expect(trackList(page)).toHaveCount(1);
      await step("Back to the arrangement from the dock");

      await page.goBack();
      await expectView(page, "Mixer");
      await expect(page).toHaveURL(mixerUrl);
      await step("Back button: the mixer again");

      // 9. Reload the page. The project reopens on the mixer, with the fader
      //    still where you put it.
      //
      // The reload is only meaningful once the edits have been written, which
      // the save status is how the editor reports.
      await expect(page.locator(".save-status")).toHaveText("Saved", {
        timeout: 10_000,
      });
      await reloadPage(page);
      await expectView(page, "Mixer");
      await expect(
        page.getByRole("slider", { name: `Volume for ${trackName}` }),
      ).toHaveValue("0.4");
      await step("Reload the mixer: it reopens there, fader where you left it");
    },
  );
});
