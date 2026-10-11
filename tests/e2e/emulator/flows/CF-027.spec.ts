import { walkthrough } from "../../support/walkthrough";
import {
  arrangement,
  assistantButton,
  boxOf,
  composer,
  conversation,
  goToView,
  newProject,
  panel,
  proposal,
  proposalButton,
  reloadSaved,
  scope,
  seedDisclosureAnswered,
  swingPercent,
  volume,
} from "../support/assistant";
import { expect, test } from "../support/test";

/**
 * `CF-027`: a producer asks the assistant for a change, tries it, and keeps it.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for #72 (AI-004, the assistant
 * conversation and proposal UI), and it is frozen once it lands: a later PR
 * that changes an assertion here has to say so in its body and justify it.
 *
 * The marker it carried while the assistant did not exist was removed by the
 * PR that completes GRV-5 (#72).
 *
 * **Locators.** Every assistant locator is assumed from #72 and its reference
 * design, and listed in `../support/assistant.ts`.
 *
 * **The scripted provider.** The flow's precondition is that the emulator
 * suite's gateway answers from a scripted provider (#69), not a model: asked
 * to loosen the beat, it proposes swing at 58% and the BD track 3 dB quieter.
 * The spec cannot arrange that itself, and does not try. The two values are
 * read from the proposal's own rows where they matter, so the spec pins the
 * shape of the proposal, not the fader's scale.
 *
 * **The disclosure.** The assistant asks for its disclosure before the first
 * message (GRV-8). The flow's precondition is an account that has already
 * answered it, so the spec seeds that answer; it does not click through it.
 *
 * Out of scope, per the flow: what the assistant says, stopping a reply,
 * provider failure, stale proposals, "Why this works", the preview and changed
 * outlines, audibility, and pack and video recommendations.
 *
 * Runs against the Firestore/Auth emulator because step 9 is a real reload.
 */

const TRACK = "BD";
const PROPOSED_SWING = 58;

test.describe("CF-027", () => {
  test("a producer asks the assistant for a change, tries it, and keeps it", async ({
    page,
    invitedProducer,
  }) => {
    await seedDisclosureAnswered(invitedProducer.uid);
    const step = walkthrough(page, {
      id: "CF-027",
      title: "A producer asks the assistant for a change, tries it, and keeps it",
    });

    // 1. Create a new project. It opens on the arrangement.
    await newProject(page);
    await expect(arrangement(page)).toBeVisible();
    const startingSwing = await swingPercent(page);
    expect(startingSwing).not.toBe(PROPOSED_SWING);
    await goToView(page, "Mixer");
    const startingVolume = Number(await volume(page, TRACK).inputValue());
    await goToView(page, "Arrangement");
    await expect(arrangement(page)).toBeVisible();

    // 2. Press the Assistant button in the header. The assistant opens
    //    floating over the bottom-right corner of the editor, ready to type
    //    into. It says its scope is the selected track, BD.
    await assistantButton(page).click();
    await expect(panel(page)).toBeVisible();
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("the page has no viewport");
    const box = await boxOf(panel(page), "the assistant");
    expect(box.x + box.width).toBeGreaterThan(viewport.width * 0.9);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 2);
    expect(box.width).toBeLessThan(viewport.width / 2);
    await expect(composer(page)).toBeFocused();
    await expect(scope(page)).toHaveAccessibleName(new RegExp(`\\b${TRACK}\\b`));
    await step("Open the assistant, scoped to BD");

    // 3. Type "Loosen the beat" and press Enter. Your message appears in the
    //    conversation, marked with its scope, and the assistant's reply
    //    follows it.
    await composer(page).fill("Loosen the beat");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("");
    await expect(conversation(page)).toContainText("Loosen the beat");
    await expect(conversation(page)).toContainText(new RegExp(`Scope\\W+${TRACK}\\b`));
    await step("Send a message, and a reply follows");

    // 4. The reply ends with a proposal that lists both changes, each from its
    //    current value to the new one. Nothing in the song has changed yet:
    //    swing reads what it did before.
    await expect(proposal(page)).toBeVisible({ timeout: 15_000 });
    await expect(proposal(page)).toContainText(/Swing/);
    await expect(proposal(page)).toContainText(`${startingSwing}%`);
    await expect(proposal(page)).toContainText(`${PROPOSED_SWING}%`);
    await expect(proposal(page)).toContainText(
      new RegExp(`${TRACK}\\b.*volume|volume.*\\b${TRACK}\\b`, "i"),
    );
    expect(await swingPercent(page)).toBe(startingSwing);
    await step("A proposal: two changes, old to new");

    // 5. Press Preview. The editor goes to the mixer, where the change can be
    //    seen. BD's volume fader sits at the proposed level, and swing reads
    //    58%.
    await proposalButton(page, "Preview").click();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+\/mixer$/);
    await expect.poll(() => swingPercent(page)).toBe(PROPOSED_SWING);
    await expect
      .poll(async () => Number(await volume(page, TRACK).inputValue()))
      .toBeLessThan(startingVolume);
    const proposedVolume = Number(await volume(page, TRACK).inputValue());
    await step("Preview it on the mixer");

    // 6. Press Cancel. The editor goes back to the arrangement. Swing reads
    //    what it did before, and BD's volume is where it was. There is nothing
    //    to undo.
    await proposalButton(page, "Cancel").click();
    await expect(arrangement(page)).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/prj_[^/]+$/);
    await expect.poll(() => swingPercent(page)).toBe(startingSwing);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await goToView(page, "Mixer");
    expect(Number(await volume(page, TRACK).inputValue())).toBe(startingVolume);
    await goToView(page, "Arrangement");
    await step("Cancel: back, and nothing changed");

    // 7. Press Preview again, then Apply. The proposal says it was applied.
    //    Swing reads 58%, and BD's volume is at the proposed level.
    await proposalButton(page, "Preview").click();
    await expect(page).toHaveURL(/\/mixer$/);
    await proposalButton(page, "Apply").click();
    await expect(proposal(page)).toContainText(/Applied/);
    await expect.poll(() => swingPercent(page)).toBe(PROPOSED_SWING);
    expect(Number(await volume(page, TRACK).inputValue())).toBe(proposedVolume);
    await step("Preview again and apply");

    // 8. Undo once. Both changes are gone. Redo once. Both are back.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => swingPercent(page)).toBe(startingSwing);
    expect(Number(await volume(page, TRACK).inputValue())).toBe(startingVolume);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => swingPercent(page)).toBe(PROPOSED_SWING);
    expect(Number(await volume(page, TRACK).inputValue())).toBe(proposedVolume);
    await step("One undo takes both, one redo");

    // 9. Reload the page. Swing still reads 58%, and BD's volume is still at
    //    the proposed level.
    await reloadSaved(page);
    await expect(volume(page, TRACK)).toBeVisible();
    expect(await swingPercent(page)).toBe(PROPOSED_SWING);
    expect(Number(await volume(page, TRACK).inputValue())).toBe(proposedVolume);
    await step("Reload: the change is still there");
  });
});
