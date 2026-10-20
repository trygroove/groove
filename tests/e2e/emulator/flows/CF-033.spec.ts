import { walkthrough } from "../../support/walkthrough";
import {
  audition,
  backToInstrument,
  drumMachine,
  expectSelected,
  insertButton,
  insertedBackToInstrument,
  library,
  listedNames,
  newProjectOnInstrumentView,
  openPadSlot,
  precondition,
  railButton,
  slotSound,
  soundList,
} from "../support/library";
import { reloadPage } from "../support/reload";
import { expect, test } from "../support/test";

/**
 * `CF-033`: a producer finds a sound they heard earlier.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for the recently heard half of
 * #815, and it is frozen once it lands: a later PR that changes an assertion
 * here has to say so in its body and justify it.
 *
 * **Locators.** The library's locators are `../support/library.ts`'s. This
 * spec relies on three of its own, which #815 builds to:
 *
 *  - the rail's place is a button named "Recently heard";
 *  - its empty state is text starting "Nothing heard yet", and says how to
 *    hear something by naming auditioning;
 *  - the place lists its sounds in the same "Sounds" list as All sounds, so
 *    the order on screen is `listedNames(soundList(page))`.
 *
 * **Fixture library.** Any three kicks will do: the BD pad opens the library
 * on kicks, and the delivered library the emulator suite serves holds more
 * than four, so the preconditions are met.
 *
 * Out of scope, per the flow: how many sounds the list keeps (unit-tested),
 * another device or browser, and Browse packs' "Hear it" (component-tested).
 *
 * Runs against the Firestore/Auth emulator because step 5 is a real reload,
 * and recently heard has to survive it.
 */

test.describe("CF-033", () => {
  test("a producer finds a sound they heard earlier", async ({ page }) => {
    const step = walkthrough(page, {
      id: "CF-033",
      title: "A producer finds a sound they heard earlier",
    });

    // 1. Create a new project, go to the instrument view and press the "BD"
    //    pad's sample slot. The editor goes to the Library view. Choose
    //    Recently heard. It says nothing has been heard yet, and how to hear
    //    something.
    const projectUrl = await newProjectOnInstrumentView(page);
    const starterKick = await slotSound(page, "BD");
    await openPadSlot(page, "BD");
    const kicks = (await listedNames(soundList(page))).filter(
      (name) => name !== starterKick,
    );
    precondition(kicks.length >= 3, "CF-033", "three kicks besides the starter's");
    const [first, second, third] = kicks;
    await railButton(page, "Recently heard").click();
    await expect(railButton(page, "Recently heard")).toHaveAttribute(
      "aria-current",
      "true",
    );
    const empty = library(page).getByText(/^Nothing heard yet/);
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/audition/i);
    await expect(soundList(page)).toHaveCount(0);
    await step("Choose Recently heard: nothing has been heard yet");

    // 2. Go back to All sounds and hear three kicks, one after another,
    //    without inserting any.
    await railButton(page, "All sounds").click();
    for (const kick of [first, second, third]) {
      await audition(soundList(page), kick).click();
      await expectSelected(page, kick);
    }
    await step("Hear three kicks in All sounds");

    // 3. Choose Recently heard. The three kicks are listed, the last one heard
    //    first.
    await railButton(page, "Recently heard").click();
    await expect.poll(() => listedNames(soundList(page))).toEqual([third, second, first]);
    await step("Choose Recently heard: the last kick heard is first");

    // 4. Hear the first kick you heard again, at the bottom of the list. The
    //    list holds still while you listen. Choose Recently heard again: that
    //    kick is now at the top.
    await audition(soundList(page), first).click();
    await expectSelected(page, first);
    expect(await listedNames(soundList(page))).toEqual([third, second, first]);
    await railButton(page, "Recently heard").click();
    await expect.poll(() => listedNames(soundList(page))).toEqual([first, third, second]);
    await step("Hear the first kick again: it moves to the top");

    // 5. Press 3 to go back to the instrument view without inserting anything,
    //    and reload the page.
    await backToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(starterKick);
    await reloadPage(page);
    await expect(page).toHaveURL(`${projectUrl}/instrument`);
    await expect(drumMachine(page)).toBeVisible();
    await step("Press 3 without inserting, and reload");

    // 6. Press the slot again and choose Recently heard. The same kicks are
    //    there in the same order.
    await openPadSlot(page, "BD");
    await railButton(page, "Recently heard").click();
    await expect.poll(() => listedNames(soundList(page))).toEqual([first, third, second]);
    await step("After the reload, Recently heard still lists them in order");

    // 7. Select one and press Insert. The editor goes back to the instrument
    //    view, and the slot names that kick.
    await audition(soundList(page), third).click();
    await expectSelected(page, third);
    await insertButton(page, third).click();
    await insertedBackToInstrument(page);
    await expect.poll(() => slotSound(page, "BD")).toBe(third);
    await step("Insert one: back on the instrument, the slot names that kick");
  });
});
