import { walkthrough } from "../support/walkthrough";
import {
  answerDisclosure,
  assistantButton,
  composer,
  newProject,
  panel,
  proposal,
} from "./support/assistant";
import { expect, type Page, test } from "./support/test";

/**
 * Four takes of a part to pick from (GRV-207), against the real gateway and
 * its scripted provider (`[takes]` in `emulatorProvider.ts`): one card holds
 * the four, each heard in the song before choosing; Use this applies that one
 * take through the proposal path, "4 more" replaces the four with a fresh
 * set, and "None of these" applies nothing. A drum pattern (GRV-213,
 * `[drum takes]`) is offered the same way and heard on a loop.
 */

const takesCards = (page: Page) => panel(page).getByRole("region", { name: /^Takes:/ });
const takesCard = (page: Page) => takesCards(page).last();

async function askForTakes(
  page: Page,
  request = "Write me a lead melody [takes]",
): Promise<void> {
  await assistantButton(page).click();
  await answerDisclosure(page);
  await composer(page).fill(request);
  await page.keyboard.press("Enter");
  await expect(takesCard(page).getByRole("listitem")).toHaveCount(4, { timeout: 15_000 });
}

test.describe("four takes to pick from", () => {
  test("hears a take in the song, then uses another, applying only that one", async ({
    page,
  }) => {
    await newProject(page);
    await askForTakes(page);
    const card = takesCard(page);
    await expect(card).toContainText("Lead melody");
    await expect(card).toContainText("Busy and high");

    await card.getByRole("button", { name: "Hear take 2" }).click();
    await expect(card.getByRole("button", { name: "Stop take 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(card.getByRole("status")).toContainText("Hearing take 2");
    // Switching is one press, and the song keeps playing.
    await card.getByRole("button", { name: "Hear take 4" }).click();
    await expect(card.getByRole("status")).toContainText("Hearing take 4");

    await card.getByRole("button", { name: "Use take 3" }).click();
    await expect(card.getByRole("status")).toContainText("Using take 3");
    await expect(card.getByRole("listitem")).toHaveCount(0);
    await expect(proposal(page)).toContainText("Lead melody · take 3");
    await expect(proposal(page).getByRole("status")).toContainText(
      "Applied as one undo step",
    );
    await expect(proposal(page).getByRole("button", { name: "Undo" })).toBeVisible();
  });

  test("4 more replaces the takes with a fresh set, and None of these applies nothing", async ({
    page,
  }) => {
    await newProject(page);
    await askForTakes(page);
    const first = takesCard(page);
    // Pressed while a take is heard: the fresh set is for the song as it is.
    await first.getByRole("button", { name: "Hear take 1" }).click();
    await expect(first.getByRole("status")).toContainText("Hearing take 1");
    await first.getByRole("button", { name: "4 more", exact: true }).click();
    await expect(takesCards(page)).toHaveCount(2, { timeout: 15_000 });
    await expect(takesCards(page).first().getByRole("status")).toContainText(
      "Set aside for 4 more",
    );
    const fresh = takesCard(page);
    await expect(fresh.getByRole("listitem")).toHaveCount(4);
    await expect(fresh).toContainText("Syncopated mid");
    await expect(fresh.getByRole("button", { name: "Use take 1" })).toBeEnabled();

    await fresh.getByRole("button", { name: "None of these", exact: true }).click();
    await expect(fresh.getByRole("status")).toContainText("None of these used");
    await expect(panel(page).getByRole("region", { name: /^Proposal\b/ })).toHaveCount(0);
  });

  test("offers four takes of a drum pattern, heard on a loop, and applies only the one used", async ({
    page,
  }) => {
    await newProject(page);
    await askForTakes(page, "Write me a beat [drum takes]");
    const card = takesCard(page);
    await expect(card).toContainText("Drum pattern");
    await expect(card).toContainText("Swung shuffle");

    await card.getByRole("button", { name: "Hear take 3" }).click();
    await expect(card.getByRole("status")).toContainText("Hearing take 3 on a loop");
    await card.getByRole("button", { name: "Hear take 1" }).click();
    await expect(card.getByRole("status")).toContainText("Hearing take 1 on a loop");

    await card.getByRole("button", { name: "Use take 2" }).click();
    await expect(card.getByRole("status")).toContainText("Using take 2");
    await expect(proposal(page)).toContainText("Drum pattern · take 2");
    await expect(proposal(page).getByRole("status")).toContainText(
      "Applied as one undo step",
    );
  });

  test("says which change did not fit when not one drum take fits", async ({ page }) => {
    const step = walkthrough(page, { id: "GRV-213", title: "Drum takes that don't fit" });
    await newProject(page);
    await askForTakes(page, "Write me a beat [drum takes] [unfit]");
    const card = takesCard(page);
    await expect(card.getByRole("status")).toHaveText(
      "The assistant tried to add a note that doesn't fit your song. These takes don't fit your song as it is. Nothing changed.",
    );
    await expect(card.getByRole("button", { name: "Hear take 1" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Use take 1" })).toBeDisabled();
    await step("A drum takes card none of whose takes fits, saying which change did not");
  });
});
