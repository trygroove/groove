import { walkthrough } from "../../support/walkthrough";
import {
  audition,
  backToInstrument,
  expectSelected,
  goToInstrumentView,
  insertButton,
  insertedBackToInstrument,
  library,
  libraryHeader,
  listedNames,
  newProjectOnInstrumentView,
  openPadSlot,
  railButton,
  reloadOnInstrumentView,
  slotSound,
  soundList,
} from "../support/library";
import { expect, type Locator, type Page, test } from "../support/test";
import { pressView } from "../support/views";

/**
 * `CF-026`: a producer keeps a sound as a favourite and finds it in another
 * project.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for the favourites slice of
 * #449 (LIB-010, the library redesign), and it is frozen once it lands: a
 * later PR that changes an assertion here has to say so in its body and
 * justify it.
 *
 * Favourites live per user in Firestore (#691, LIB-011); #815 built the
 * hearts, `L` and the Favourites place on them and removed this flow's
 * `test.fixme`.
 *
 * **Revised for #817.** The library is the Library view on `4`, not a dialog
 * with a close button: leaving it without inserting is pressing `3`, Insert
 * goes back to the instrument view, and step 6 comes back to it with `4`.
 *
 * **Locators.** Every library locator is assumed from #449 and the reference
 * design, and listed in `../support/library.ts`. This spec relies on two in
 * particular:
 *
 *  - the heart is a toggle button named "Favourite <name>", pressed when the
 *    sound is a favourite ("its heart fills");
 *  - the rail's "Favourites" button shows how many there are, so "Favourites
 *    counts one" is its text reading "Favourites" then 1.
 *
 * The way back to the dashboard is the editor header's "Projects" link, which
 * exists today (`src/editor/composition/EditorHeader.tsx`).
 *
 * **Fixture library.** Any kick will do, so the delivered library the emulator
 * suite serves already meets this flow's preconditions.
 *
 * Out of scope, per the flow: favourites on another device or browser, a
 * guest's favourites after registering (both #691's, in the rules and
 * repository suites), and unfavouriting.
 *
 * Runs against the Firestore/Auth emulator because step 6 is a real reload.
 */

const heart = (page: Page, name: string): Locator =>
  library(page).getByRole("button", { name: `Favourite ${name}`, exact: true });

test.describe("CF-026", () => {
  test("a producer keeps a sound as a favourite and finds it in another project", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-026",
      title: "A producer keeps a sound as a favourite and finds it in another project",
    });

    // 1. Create a new project, go to the instrument view and press the "BD"
    //    pad's sample slot. The editor goes to the Library view.
    const firstProject = await newProjectOnInstrumentView(page);
    const starterKick = await slotSound(page, "BD");
    await openPadSlot(page, "BD");
    await step('Press the "BD" pad\'s sample slot');

    // 2. Mark a kick as a favourite. Its heart fills, and Favourites counts
    //    one.
    const kick = (await listedNames(soundList(page))).find(
      (name) => name !== starterKick,
    );
    if (!kick) throw new Error("the library lists no kick but the starter's");
    await expect(heart(page, kick)).toHaveAttribute("aria-pressed", "false");
    await heart(page, kick).click();
    await expect(heart(page, kick)).toHaveAttribute("aria-pressed", "true");
    await expect(railButton(page, "Favourites")).toHaveText(/^\s*Favourites\D*1\b/);
    await step("Mark a kick as a favourite: its heart fills, and Favourites counts one");

    // 3. Press 3 to go back to the instrument view without inserting
    //    anything.
    await backToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(starterKick);
    await step("Press 3 to go back without inserting anything");

    // 4. Go back to the dashboard and create a second project. Press its "BD"
    //    pad's sample slot and choose Favourites. The kick you marked is
    //    listed.
    await page.getByRole("link", { name: "Projects" }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+$/);
    const secondProject = page.url();
    expect(secondProject).not.toBe(firstProject);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await goToInstrumentView(page);
    await openPadSlot(page, "BD");
    await railButton(page, "Favourites").click();
    await expect.poll(() => listedNames(soundList(page))).toEqual([kick]);
    await step("In a second project, choose Favourites: the kick you marked is listed");

    // 5. Insert it, then press 3. The slot names that kick.
    await audition(soundList(page), kick).click();
    await expectSelected(page, kick);
    await insertButton(page, kick).click();
    await insertedBackToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(kick);
    await step("Insert it: back on the instrument, the slot names that kick");

    // 6. Reload the page. Press 4 and choose Favourites. The kick is still
    //    there, still marked.
    await reloadOnInstrumentView(page, secondProject);
    await expect.poll(() => slotSound(page, "BD")).toBe(kick);
    await pressView(page, "Library");
    await expect(libraryHeader(page)).toContainText("BD");
    await railButton(page, "Favourites").click();
    await expect.poll(() => listedNames(soundList(page))).toEqual([kick]);
    await expect(heart(page, kick)).toHaveAttribute("aria-pressed", "true");
    await step("Reload, press 4 and choose Favourites: the kick is still marked");
  });
});
