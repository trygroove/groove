import { walkthrough } from "../../support/walkthrough";
import { reloadPage } from "../support/reload";
import { expect, type Locator, type Page, test } from "../support/test";

/**
 * `CF-031` — a producer sends a track to a reverb return.
 *
 * Read the flow in `docs/core-flows.md`; the numbered comments below are its
 * steps, in its words. This is the acceptance contract for `LOOP-021` (#386)
 * and is frozen once it lands: a later PR that changes an assertion here has to
 * say so in its body and justify it.
 *
 * It moves between views by the dock's links, by name, never by number key, so
 * it reads the same before and after the five-view dock (#817).
 *
 * Runs against the Firestore/Auth emulator rather than the mock backend,
 * because step 8 is a real `page.reload()` and the mock repository is a fresh,
 * empty store on every page load.
 */

/** The dock's links to two of the views (#304). */
const viewLink = (page: Page, name: "Mixer" | "Instrument"): Locator =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });
const mixer = (page: Page): Locator => page.getByRole("region", { name: "Mixer" });

/**
 * The mixer's returns: a named list of strips between the tracks and the
 * master, one per return bus, in the song's order.
 */
const returns = (page: Page): Locator =>
  mixer(page).getByRole("list", { name: "Returns" }).getByRole("listitem");
const returnStrip = (page: Page): Locator => returns(page).first();

/**
 * A track's send to a return lives on the track's strip. Its controls are named
 * for the track and the return; the starter track's name is the user's content,
 * not something this flow asserts, so it is matched loosely.
 */
const addSend = (page: Page): Locator =>
  mixer(page).getByRole("button", { name: /^Send .+ to Verb$/ });
const sendLevel = (page: Page): Locator =>
  mixer(page).getByRole("slider", { name: /^Send level from .+ to Verb$/ });

/** A return's own chain, in the instrument view's return mode (#386). */
const returnChain = (page: Page): Locator =>
  page.getByRole("region", { name: "Return effects" });
const returnDevices = (page: Page): Locator =>
  returnChain(page).getByRole("list", { name: "Return chain" }).getByRole("listitem");

// Part of the per-PR `@sanity` subset (.github/workflows/ci.yml).
test.describe("CF-031", { tag: "@sanity" }, () => {
  test("a producer sends a track to a reverb return", async ({ page }) => {
    test.setTimeout(120_000);

    const step = walkthrough(page, {
      id: "CF-031",
      title: "A producer sends a track to a reverb return",
    });

    // 1. Create a new project and switch to the mixer. The starter track's
    //    strip and the master are there, and no returns.
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await viewLink(page, "Mixer").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/mixer$/);
    const mixerUrl = page.url();
    await expect(mixer(page).getByRole("button", { name: "Master" })).toBeVisible();
    await expect(returns(page)).toHaveCount(0);
    await step("A new project's mixer, with no returns");

    // 2. Add a return. A return strip appears after the tracks and before the
    //    master, with its own volume and pan. Rename it "Verb".
    await mixer(page).getByRole("button", { name: "Add return" }).click();
    await expect(returns(page)).toHaveCount(1);
    await expect(
      returnStrip(page).getByRole("slider", { name: /^Volume for / }),
    ).toBeVisible();
    await expect(
      returnStrip(page).getByRole("slider", { name: /^Pan for / }),
    ).toBeVisible();
    const name = returnStrip(page).getByRole("textbox", { name: "Return name" });
    await name.fill("Verb");
    await name.press("Enter");
    await expect(name).toHaveValue("Verb");
    await step("Add a return and call it Verb");

    // 3. Select the return and go to the instrument view. It shows the
    //    return's device chain, empty, and no instrument. Add a reverb to it.
    await returnStrip(page).getByRole("button", { name: "Edit Verb" }).click();
    await expect(
      returnStrip(page).getByRole("button", { name: "Edit Verb" }),
    ).toHaveAttribute("aria-pressed", "true");
    await viewLink(page, "Instrument").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/instrument$/);
    await expect(returnChain(page)).toBeVisible();
    await expect(returnDevices(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Instrument" })).toHaveCount(0);
    await returnChain(page)
      .getByRole("group", { name: "Add device" })
      .getByRole("button", { name: "Add reverb device" })
      .click();
    await expect(returnDevices(page)).toHaveText([/Reverb/]);
    await step("The return's own chain, with a reverb on it");

    // 4. Go back to the mixer. The return's strip reads Reverb. Send the
    //    starter track to the return, and drag the send level up.
    await viewLink(page, "Mixer").click();
    await expect(returnStrip(page)).toContainText("Reverb");
    await addSend(page).click();
    await expect(sendLevel(page)).toBeVisible();
    const levelBefore = await sendLevel(page).inputValue();
    // A range input's `fill` is one input and one change: one gesture.
    await sendLevel(page).fill("0.6");
    await expect(sendLevel(page)).toHaveValue("0.6");
    await step("Send the starter track to the return");

    // 5. Undo once. The send level drops back to where the send started, in
    //    one step. Redo. It is back up.
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(sendLevel(page)).toHaveValue(levelBefore);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(sendLevel(page)).toHaveValue("0.6");

    // 6. Turn the return's volume down.
    const volume = returnStrip(page).getByRole("slider", { name: "Volume for Verb" });
    await volume.fill("0.5");
    await expect(volume).toHaveValue("0.5");
    await step("Turn the return down");

    // 7. Remove the return. Its strip goes, and so does the starter track's
    //    send to it. Undo once. The return is back, with its reverb, and so is
    //    the send, at the level you left it.
    await returnStrip(page).getByRole("button", { name: "Delete Verb" }).click();
    await expect(returns(page)).toHaveCount(0);
    await expect(sendLevel(page)).toHaveCount(0);
    await expect(addSend(page)).toHaveCount(0);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(returns(page)).toHaveCount(1);
    await expect(returnStrip(page)).toContainText("Reverb");
    await expect(sendLevel(page)).toHaveValue("0.6");
    await step("Remove the return, then undo: the send comes back with it");

    // 8. Reload the page. The project reopens on the mixer. The return is
    //    still called "Verb", still carries the reverb and still sits at the
    //    volume you set, and the starter track still sends to it at that level.
    await expect(page.locator(".save-status")).toHaveText("Saved", {
      timeout: 10_000,
    });
    await reloadPage(page);
    await expect(page).toHaveURL(mixerUrl);
    await expect(returns(page)).toHaveCount(1);
    await expect(
      returnStrip(page).getByRole("textbox", { name: "Return name" }),
    ).toHaveValue("Verb");
    await expect(returnStrip(page)).toContainText("Reverb");
    await expect(
      returnStrip(page).getByRole("slider", { name: "Volume for Verb" }),
    ).toHaveValue("0.5");
    await expect(sendLevel(page)).toHaveValue("0.6");
    await step("Reload: the return, its reverb and the send are all still there");
  });
});
