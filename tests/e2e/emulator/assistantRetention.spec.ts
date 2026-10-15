import { walkthrough } from "../support/walkthrough";
import {
  answerDisclosure,
  arrangement,
  assistantButton,
  composer,
  conversation,
  disclosure,
  newProject,
  panel,
  panelButton,
  storedTranscripts,
} from "./support/assistant";
import { expect, test } from "./support/test";

/**
 * The assistant's disclosure and its setting (GRV-8) against the real
 * `assistantRetention` callable in the Functions emulator: a fresh account
 * meets the disclosure before it can type, answers it, and finds the same
 * control, with its scope beside it, in the panel's settings. What the
 * server kept is read back from the Firestore emulator, so the spec fails if
 * a yes keeps nothing or a no leaves anything behind.
 */

const LABEL = "Keep my conversations with Cue for 30 days";
const SCOPE =
  "This controls Groove's own copy only. It does not take back anything already sent to Anthropic.";

test.describe("the assistant's disclosure and setting", () => {
  test("is answered before the first message, and changed later in settings", async ({
    page,
    invitedProducer,
  }) => {
    const step = walkthrough(page, { id: "GRV-8", title: "Assistant disclosure" });
    await newProject(page);
    await assistantButton(page).click();

    // The disclosure stands where the composer would be.
    await expect(disclosure(page)).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await expect(disclosure(page)).toContainText("Anthropic does not use anything");
    await expect(disclosure(page)).toContainText(SCOPE);
    // Keeping is the default (GRV-97): a notice with a way out, not a question.
    await expect(
      disclosure(page).getByRole("group", {
        name: "Groove keeps your conversations for 30 days",
      }),
    ).toBeVisible();
    await expect(
      disclosure(page).getByRole("button", { name: "Don't keep them" }),
    ).toBeVisible();
    await step("Before the first message: what is sent, what is kept");

    await answerDisclosure(page, "OK");
    await expect(composer(page)).toBeFocused();
    await composer(page).fill("Make it groove");
    await page.keyboard.press("Enter");
    await expect(conversation(page)).toContainText("Here is one idea.");

    // OK keeps the turn, server-side: the message and the reply.
    await expect
      .poll(async () => (await storedTranscripts(invitedProducer.uid)).length)
      .toBe(1);
    const [kept] = await storedTranscripts(invitedProducer.uid);
    expect(kept?.userMessage).toBe("Make it groove");
    expect(kept?.reply).toContain("Here is one idea.");

    // The setting shows what was answered, and opening it changes nothing.
    await panelButton(page, "Cue settings").click();
    const box = panel(page).getByRole("checkbox", { name: LABEL });
    await expect(box).toBeChecked();
    await expect(panel(page)).toContainText(SCOPE);
    await step("The setting, with its scope beside it");

    await box.click();
    await expect(panel(page)).toContainText(
      "Groove has stopped keeping your conversations and deleted the ones it kept.",
    );
    await expect(box).not.toBeChecked();
    await step("Turned off: kept conversations are deleted");
    // Turning it off deleted what was kept, and a later turn is not kept.
    expect(await storedTranscripts(invitedProducer.uid)).toEqual([]);
    await panel(page).getByRole("button", { name: "Back to the conversation" }).click();
    await composer(page).fill("Once more");
    await page.keyboard.press("Enter");
    await expect(
      conversation(page).getByText("then listen to it in the loop."),
    ).toHaveCount(2);
    expect(await storedTranscripts(invitedProducer.uid)).toEqual([]);

    // A reload asks again from the account's stored answer: no disclosure.
    await page.reload();
    await arrangement(page).waitFor();
    // The panel remembers whether it was open on this device.
    if (!(await panel(page).isVisible())) await assistantButton(page).click();
    await expect(composer(page)).toBeVisible();
    await expect(disclosure(page)).toHaveCount(0);
    await panelButton(page, "Cue settings").click();
    await expect(panel(page).getByRole("checkbox", { name: LABEL })).not.toBeChecked();
    expect(await storedTranscripts(invitedProducer.uid)).toEqual([]);
  });
});
