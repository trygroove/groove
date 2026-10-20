import {
  answerDisclosure,
  arrangement,
  assistantButton,
  composer,
  goToView,
  newProject,
  panel,
  proposal,
  proposalButton,
  volume,
} from "./support/assistant";
import { expect, type Page, test } from "./support/test";

/**
 * The assistant's proposal going out of date (GRV-5) against the real
 * gateway and its scripted provider: an edit here to what it changes, or any
 * change made in another tab and saved through the emulator, moves the song
 * under a proposal (GRV-144: an edit here to something else leaves its parts
 * as they are). Its card says so, Apply all is off, and Refresh asks for a
 * new one in the same scope.
 * CF-027 covers the proposal that stays current; this is what it leaves out.
 */

async function askToLoosen(page: Page): Promise<void> {
  await assistantButton(page).click();
  await answerDisclosure(page);
  await composer(page).fill("Loosen the beat");
  await page.keyboard.press("Enter");
  await expect(proposalButton(page, "Apply all")).toBeEnabled({ timeout: 15_000 });
}

const muteBd = (page: Page) =>
  page.getByRole("button", { name: "Mute BD", exact: true }).first();

/**
 * Moves BD's volume on the mixer, which the proposal changes too: an edit to
 * what one of its parts touches (GRV-144).
 */
async function nudgeBdVolume(page: Page): Promise<void> {
  await goToView(page, "Mixer");
  await volume(page, "BD").focus();
  await page.keyboard.press("ArrowDown");
}

test.describe("an assistant proposal's explanation", () => {
  test("names the assistant's goal and technique, and links the changed controls", async ({
    page,
  }) => {
    await newProject(page);
    await askToLoosen(page);

    // The control rows are links that show the control.
    await expect(
      proposal(page).getByRole("list", { name: "Changes" }).getByRole("link"),
    ).toHaveText(["Swing", "BD volume"]);

    await proposal(page).getByText("Why this works").click();
    const why = proposal(page).locator("details");
    // The scripted provider's explain_change, not the request repeated.
    await expect(why).toContainText("played rather than programmed");
    await expect(why).toContainText("Swing delays every second 16th note");
    await why.getByRole("link", { name: "Show BD volume" }).click();
    await expect(page.getByRole("slider", { name: "Volume for BD" })).toBeVisible();
  });
});

test.describe("an assistant proposal that goes out of date", () => {
  test("after an edit here to what it changes: Apply all is off, and Refresh asks again", async ({
    page,
  }) => {
    await newProject(page);
    await askToLoosen(page);

    await nudgeBdVolume(page);

    await expect(proposal(page)).toContainText("Out of date");
    await expect(proposalButton(page, "Apply all")).toBeDisabled();
    await proposal(page).getByRole("button", { name: "Refresh" }).click();
    // The new proposal, for the song as it is now, can be applied.
    await expect(panel(page).getByRole("region", { name: /^Proposal\b/ })).toHaveCount(
      2,
      {
        timeout: 15_000,
      },
    );
    await expect(proposalButton(page, "Apply all")).toBeEnabled({ timeout: 15_000 });
  });

  test("after a change saved in another tab", async ({ page }) => {
    const projectUrl = await newProject(page);
    await askToLoosen(page);

    const other = await page.context().newPage();
    try {
      await other.goto(projectUrl);
      await other.getByTestId("arrangement-view-ready").waitFor();
      await muteBd(other).click();
      await expect(other.locator(".save-status")).toHaveText("Saved", {
        timeout: 10_000,
      });

      await expect(proposal(page)).toContainText("Out of date", { timeout: 10_000 });
      await expect(proposalButton(page, "Apply all")).toBeDisabled();
    } finally {
      await other.close();
    }
  });
});

test.describe("an assistant proposal across a reload", () => {
  test("comes back out of date with the question beside it, and Refresh asks for one that applies (GRV-135)", async ({
    page,
  }) => {
    await newProject(page);
    await askToLoosen(page);
    // The preview opened by itself on the mixer (GRV-193); end it, so the
    // reload lands on the arrangement.
    await proposalButton(page, "Cancel").click();
    await expect(page).not.toHaveURL(/\/mixer$/);
    // A question waiting in the same conversation comes back as it did before.
    await composer(page).fill("Build me a drop [ask]");
    await page.keyboard.press("Enter");
    const question = panel(page).getByRole("region", { name: "Coproducer asks" });
    await expect(question).toContainText("Where should the drop land?");

    await page.reload();
    await arrangement(page).waitFor();
    // The panel remembers whether it was open on this device.
    if (!(await panel(page).isVisible())) await assistantButton(page).click();

    await expect(proposal(page)).toHaveAccessibleName("Proposal: Loosen the beat");
    await expect(proposal(page)).toContainText("Out of date");
    await expect(proposal(page).getByRole("list", { name: "Changes" })).toContainText(
      "Swing",
    );
    await expect(proposalButton(page, "Apply")).toBeDisabled();
    await expect(question).toContainText("Where should the drop land?");

    await proposal(page).getByRole("button", { name: "Refresh" }).click();
    await expect(panel(page).getByRole("region", { name: /^Proposal\b/ })).toHaveCount(
      2,
      { timeout: 15_000 },
    );
    // The new one streams (GRV-144): a card whose parts apply one by one or all at once.
    await expect(proposalButton(page, "Apply all")).toBeEnabled({ timeout: 15_000 });
    await proposalButton(page, "Apply all").click();
    await expect(proposal(page)).toContainText("Applied as one undo step");
  });
});
