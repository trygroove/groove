import { walkthrough } from "../../support/walkthrough";
import {
  arrangement,
  assistantButton,
  composer,
  conversation,
  newProject,
  panel,
  recommendation,
  recommendationButton,
  recommendedSound,
  recommendedSounds,
} from "../support/assistant";
import {
  drumMachine,
  emptyUndo,
  reloadOnInstrumentView,
  slotSound,
} from "../support/library";
import { expect, test } from "../support/test";
import { expectView } from "../support/views";

/**
 * `CF-034`: a producer asks the assistant for a dustier kick, tries it in the
 * beat, and keeps it.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for GRV-23 (the assistant's
 * pack and sound recommendations), and it is frozen once it lands: a later PR
 * that changes an assertion here has to say so in its body and justify it.
 *
 * The marker it carried while the assistant could not recommend anything was
 * removed by the PR that completes GRV-23.
 *
 * **Locators.** The assistant's are `../support/assistant.ts`'s, the instrument
 * view's are `../support/library.ts`'s, and the views' are
 * `../support/views.ts`'s. Two readings are this spec's own:
 *
 *  - "the first kick it listed" is the name on the first sound's Hear button,
 *    read off the card rather than named here, so the spec pins the journey,
 *    not the scripted provider's choice of kick;
 *  - "there is nothing to undo" is the header's Undo, disabled.
 *
 * **The scripted provider.** The flow's precondition is that the emulator
 * suite's gateway answers from a scripted provider (#69): asked for something
 * dustier, it recommends kicks the project does not use from the starter
 * kick's own pack, for BD. The spec cannot arrange that itself, and does not
 * try.
 *
 * Out of scope, per the flow: what the assistant says, audibility, Open in
 * library, a pack the project does not use, unknown IDs, a card going out of
 * date, the slot's outlines, and proposals of changes (CF-027).
 *
 * Runs against the Firestore/Auth emulator because step 8 is a real reload.
 */

const TRACK = "BD";
const ASK = "The kick is too clean. Anything dustier?";

test.describe("CF-034", () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test(
    "a producer asks the assistant for a dustier kick, tries it in the beat, and keeps it",
    async ({ page }) => {
      const step = walkthrough(page, {
        id: "CF-034",
        title: "A producer asks for a dustier kick, tries it, and keeps it",
      });

      // 1. Create a new project. It opens on the arrangement, with the starter
      //    kick on the drum machine's "BD" pad.
      const projectUrl = await newProject(page);
      await expect(arrangement(page)).toBeVisible();

      // 2. Press the Assistant button, type "The kick is too clean. Anything
      //    dustier?" and press Enter. Your message appears in the conversation,
      //    and the assistant's reply follows it.
      await assistantButton(page).click();
      await expect(panel(page)).toBeVisible();
      await composer(page).fill(ASK);
      await page.keyboard.press("Enter");
      await expect(composer(page)).toHaveValue("");
      await expect(conversation(page)).toContainText(ASK);
      await step("Ask for a dustier kick");

      // 3. The reply ends with a recommended pack. It names the pack, its
      //    publisher, its version and how many sounds it holds, says in a line
      //    why it fits, and says the pack is already in this project. It lists
      //    up to three kicks, each with a button to hear it, and offers to try
      //    the first on BD. Nothing has changed: there is nothing to undo.
      await expect(recommendation(page)).toBeVisible({ timeout: 15_000 });
      await expect(recommendation(page)).toHaveAccessibleName(/Core Electronic Drums/);
      await expect(recommendation(page)).toContainText("Groove");
      await expect(recommendation(page)).toContainText(/\d+\.\d+\.\d+/);
      await expect(recommendation(page)).toContainText(/\d+ sounds/);
      await expect(recommendation(page)).toContainText(/in this project/i);
      const listed = await recommendedSounds(page).count();
      expect(listed).toBeGreaterThanOrEqual(1);
      expect(listed).toBeLessThanOrEqual(3);
      for (let index = 0; index < listed; index += 1) {
        await expect(
          recommendedSounds(page).nth(index).getByRole("button", { name: /^Hear\b/ }),
        ).toBeVisible();
      }
      const kick = await recommendedSound(page, 0);
      await expect(recommendationButton(page, `Try on ${TRACK}`)).toBeVisible();
      await expect(emptyUndo(page)).toBeDisabled();
      await step("A recommended pack, with kicks to hear and try");

      // 4. Press Try on BD. The editor goes to the instrument view, where BD's
      //    sample slot is. The card says BD is trying the first kick it listed,
      //    and the slot still names the sound it had: a sound being tried is
      //    heard, not saved. There is still nothing to undo.
      await recommendationButton(page, `Try on ${TRACK}`).click();
      await expectView(page, "Instrument");
      await expect(drumMachine(page)).toBeVisible();
      const starterKick = await slotSound(page, TRACK);
      expect(starterKick).not.toBe(kick);
      await expect(recommendation(page).locator("output")).toContainText(kick);
      await expect(recommendation(page).locator("output")).toContainText(/trying/i);
      await expect(emptyUndo(page)).toBeDisabled();
      await step("Try it on BD: heard, not saved");

      // 5. Press Put back. The editor goes back to the arrangement, the card
      //    says BD's own sound is back, and there is nothing to undo.
      await recommendationButton(page, "Put back").click();
      await expect(arrangement(page)).toBeVisible();
      await expectView(page, "Arrangement");
      await expect(recommendation(page).locator("output")).toContainText(/back/i);
      await expect(emptyUndo(page)).toBeDisabled();
      await step("Put back: nothing changed");

      // 6. Press Try on BD again, then Keep. The card says the kick was kept,
      //    and BD's sample slot names it.
      await recommendationButton(page, `Try on ${TRACK}`).click();
      await expectView(page, "Instrument");
      await recommendationButton(page, "Keep").click();
      await expect(recommendation(page).locator("output")).toContainText(/kept/i);
      await expect.poll(() => slotSound(page, TRACK)).toBe(kick);
      await step("Keep it");

      // 7. Undo once. The slot names the starter kick again. Redo once. It
      //    names the kept kick.
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => slotSound(page, TRACK)).toBe(starterKick);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(() => slotSound(page, TRACK)).toBe(kick);
      await step("One undo takes it back, one redo");

      // 8. Reload the page. BD's sample slot still names the kept kick.
      await reloadOnInstrumentView(page, projectUrl);
      expect(await slotSound(page, TRACK)).toBe(kick);
      await step("Reload: the kick is still there");
    },
  );
});
