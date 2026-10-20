import { walkthrough } from "../../support/walkthrough";
import {
  audition,
  backToInstrument,
  categoryChip,
  deliveredLibrary,
  expectSelected,
  familyTab,
  insertButton,
  insertedBackToInstrument,
  library,
  libraryHeader,
  listedNames,
  literal,
  newProjectOnInstrumentView,
  oneShots,
  openPadSlot,
  precondition,
  projectPacks,
  railButton,
  slotSound,
  soundList,
} from "../support/library";
import { reloadPage } from "../support/reload";
import { expect, type Page, test } from "../support/test";
import { expectView, pressView } from "../support/views";

/**
 * `CF-024`: a producer browses packs and uses a sound from one they did not
 * have.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for #449 (LIB-010, the library
 * redesign), and it is frozen once it lands: a later PR that changes an
 * assertion here has to say so in its body and justify it.
 *
 * **Revised for #817.** The library is the Library view on `4`, filling the
 * page, not a dialog over the editor. Insert keeps it open, showing the
 * inserted impact as the sound in the slot, `3` goes back to the instrument,
 * and `4` comes back to the library still aimed at the "BD" pad. Live since
 * #817's closing PR removed its `test.fixme`.
 *
 * **Locators.** Every library locator is assumed from #449 and the reference
 * design, and listed in `../support/library.ts`. This spec adds its own for
 * the packs view:
 *
 *  - each pack cover is a button whose name starts "Open <pack name>", and a
 *    cover for a pack the project uses carries the words "In project" (or
 *    "In this project") in its text;
 *  - the "Packs with" filter is a group named "Packs with" holding a toggle
 *    button per family, named for it ("FX");
 *  - the pack banner is headed by the pack's name and says "Joins the project
 *    when you insert a sound" (or "In this project").
 *
 * **Fixture library.** The emulator suite serves the delivered library
 * `bun run library:build` writes, read back by `deliveredLibrary()`. The flow
 * names the pack, so the spec finds "Transitions & FX" by that name there, and
 * derives everything else from the served library rather than naming sounds:
 * the project's own pack (the starter kick's), the packs with FX, and the
 * pack's impacts. A new project uses only the starter kick's pack, so
 * Transitions & FX is one it does not use.
 *
 * Out of scope, per the flow: "Hear it", pack search, category-row scrolling,
 * removing a pack, and third-party or personal packs.
 *
 * Runs against the Firestore/Auth emulator because step 8 is a real reload.
 */

/** The pack the flow opens, by the name the library shows. */
const NEW_PACK = "Transitions & FX";

const cover = (page: Page, pack: string) =>
  library(page).getByRole("button", { name: new RegExp(`^Open ${literal(pack)}\\b`) });
const anyCover = (page: Page) => library(page).getByRole("button", { name: /^Open / });
const IN_PROJECT = /\bin (this )?project\b/i;

test.describe("CF-024", () => {
  test("a producer browses packs and uses a sound from one they did not have", async ({
    page,
  }) => {
    const step = walkthrough(page, {
      id: "CF-024",
      title: "A producer browses packs and uses a sound from one they did not have",
    });

    // 1. Create a new project and go to the instrument view. Press the sample
    //    slot of the drum machine's "BD" pad. The editor goes to the Library
    //    view.
    await newProjectOnInstrumentView(page);
    const starterKick = await slotSound(page, "BD");

    const sounds = await deliveredLibrary(page);
    const projectPack = sounds.find((sound) => sound.name === starterKick)?.pack;
    precondition(projectPack, "CF-024", `the starter kick "${starterKick}"`);
    precondition(projectPack !== NEW_PACK, "CF-024", `${NEW_PACK} not in a new project`);
    const fxPacks = [
      ...new Set(sounds.filter((s) => s.family === "fx").map((s) => s.pack)),
    ];
    const impacts = oneShots(sounds, "fx", "impact")
      .filter((impact) => impact.pack === NEW_PACK)
      .map((impact) => impact.name);
    precondition(impacts.length > 0, "CF-024", `impacts in ${NEW_PACK}`);

    await openPadSlot(page, "BD");
    await step('Press the sample slot of the drum machine\'s "BD" pad');

    // 2. Choose Browse packs. The sound list gives way to pack covers, and
    //    the packs this project already uses are marked as in the project.
    await railButton(page, "Browse packs").click();
    await expect(soundList(page)).toHaveCount(0);
    await expect(cover(page, projectPack)).toBeVisible();
    await expect(cover(page, projectPack)).toContainText(IN_PROJECT);
    await expect(cover(page, NEW_PACK)).not.toContainText(IN_PROJECT);
    await step("Choose Browse packs: covers, with the project's packs marked");

    // 3. Narrow the packs to those with FX.
    await library(page)
      .getByRole("group", { name: "Packs with" })
      .getByRole("button", { name: "FX", exact: true })
      .click();
    await expect(anyCover(page)).toHaveCount(fxPacks.length);
    for (const pack of fxPacks) await expect(cover(page, pack)).toBeVisible();
    await step("Narrow the packs to those with FX");

    // 4. Open Transitions & FX, a pack the project does not use. Its sounds
    //    replace the covers, under a banner that names the pack and says it
    //    joins the project when you insert one of its sounds.
    await cover(page, NEW_PACK).click();
    await expect(anyCover(page)).toHaveCount(0);
    await expect(soundList(page)).toBeVisible();
    await expect(library(page).getByRole("heading", { name: NEW_PACK })).toBeVisible();
    await expect(
      library(page).getByText("Joins the project when you insert a sound"),
    ).toBeVisible();
    await step("Open Transitions & FX: it joins the project when you insert a sound");

    // 5. Choose the FX family, then the Impact category. Only that pack's
    //    impacts are listed.
    await familyTab(page, "FX").click();
    await categoryChip(page, "Impact").click();
    await expect
      .poll(async () => (await listedNames(soundList(page))).sort())
      .toEqual([...impacts].sort());
    await step("Choose FX, then Impact: only that pack's impacts are listed");

    // 6. Select an impact and press Insert. The editor goes back to the
    //    instrument view, and the "BD" pad's slot names that impact.
    const impact = impacts[0];
    await audition(soundList(page), impact).click();
    await expectSelected(page, impact);
    await insertButton(page, impact).click();
    await insertedBackToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(impact);
    await step(
      'Select an impact and press Insert: back on the instrument, the "BD" slot names it',
    );

    // 7. Press 4. The library is still aimed at the "BD" pad, and Transitions &
    //    FX is now listed with the project's own packs.
    await pressView(page, "Library");
    await expect(libraryHeader(page)).toContainText("BD");
    await expect(projectPacks(page)).toContainText(NEW_PACK);
    await step("Press 4: Transitions & FX is listed with the project's packs");

    // 8. Reload the page. The "BD" pad still holds the impact, and
    //    Transitions & FX is still listed with the project's packs.
    //
    // The reload happens on the Library view, where step 7 left you, and a
    // view keeps its address across a reload (#817), so it reopens there:
    // read the packs first, then press 3 to read the pad.
    await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
    await reloadPage(page);
    await expectView(page, "Library");
    await expect(libraryHeader(page)).toContainText("BD");
    await expect(projectPacks(page)).toContainText(NEW_PACK);
    await backToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(impact);
    await step("Reload: the BD pad holds the impact, and Transitions & FX is listed");
  });
});
