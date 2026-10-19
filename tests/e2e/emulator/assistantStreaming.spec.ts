import {
  answerDisclosure,
  assistantButton,
  composer,
  newProject,
  proposal,
  proposalButton,
} from "./support/assistant";
import { expect, type Page, test } from "./support/test";

/**
 * A proposal that arrives part by part (GRV-144), against the real gateway
 * and its scripted provider: `[sketch]` makes a bass track, then a line on
 * it, then places the line, a few seconds apart. The card fills in as each
 * part is accepted, a part can be applied while the rest are on their way,
 * and Apply all takes the rest as one undo step once the turn is over. The
 * card's other states are component-layer (`StreamedProposalCard.test.tsx`).
 */

const parts = (page: Page) =>
  proposal(page).getByRole("list", { name: "Changes" }).getByRole("listitem");

const undo = (page: Page) => page.getByRole("button", { name: "Undo", exact: true });

test.describe("a proposal that arrives part by part", () => {
  test("applies a part while the rest are on their way, then the rest as one", async ({
    page,
  }) => {
    await newProject(page);
    await assistantButton(page).click();
    await answerDisclosure(page);
    await composer(page).fill("Sketch a bassline [sketch]");
    await page.keyboard.press("Enter");

    // The first part lands on its own, with its own Apply, while the turn runs.
    await expect(parts(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(parts(page).first()).toContainText("Bass · new track");
    await expect(proposal(page)).toContainText("More parts on the way");
    await expect(proposalButton(page, "Apply all")).toBeDisabled();
    await proposal(page).getByRole("button", { name: "Apply Bass · new track" }).click();
    await expect(parts(page).first()).toContainText("Applied");
    await expect(undo(page)).toBeEnabled();

    // The rest arrive; the clip needed the track, which is in.
    await expect(parts(page)).toHaveCount(3, { timeout: 15_000 });
    await expect(proposal(page)).not.toContainText("More parts on the way", {
      timeout: 15_000,
    });
    await expect(parts(page).nth(1)).toContainText("Bass · 1 bar");
    await proposalButton(page, "Apply all").click();
    await expect(proposal(page)).toContainText("Applied as one undo step.");

    // One undo takes the clip and its placement; the track stays.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(parts(page).nth(1).getByRole("button")).toBeEnabled();
    await expect(parts(page).first()).toContainText("Applied");
  });
});
