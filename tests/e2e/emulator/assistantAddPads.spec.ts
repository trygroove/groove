import {
  assistantButton,
  composer,
  newProject,
  proposal,
  proposalButton,
  seedDisclosureAnswered,
} from "./support/assistant";

import { expect, type Locator, type Page, test } from "./support/test";

/**
 * GRV-138: applying an assistant proposal that adds pads to a drum machine
 * must not clear the sounds of the pads it already has. The scripted provider
 * restates the BD drum machine with two more pads and, like a real reply, no
 * sound on the old ones.
 */

const kit = (page: Page): Locator =>
  page.getByRole("region", { name: "Drum machine: BD", exact: true });

const slot = (page: Page, pad: string): Locator =>
  kit(page).getByRole("button", { name: `Sample for ${pad}`, exact: true });

async function sound(page: Page, pad: string): Promise<string> {
  await kit(page)
    .getByRole("button", { name: `Audition ${pad}`, exact: true })
    .click();
  return (
    (await slot(page, pad).locator(".sample-slot-name").textContent()) ?? ""
  ).trim();
}

test.describe("an assistant proposal that adds drum pads", () => {
  test("keeps the sound on the pads that were there, and undoes in one step", async ({
    page,
    invitedProducer,
  }) => {
    await seedDisclosureAnswered(invitedProducer.uid);
    await newProject(page);
    await page.getByRole("button", { name: "Edit BD", exact: true }).first().click();
    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("link", { name: "Instrument" })
      .click();
    await expect(kit(page)).toBeVisible();
    const kick = await sound(page, "BD");
    expect(kick).not.toBe("");
    expect(kick).not.toMatch(/no sample/i);

    await assistantButton(page).click();
    await composer(page).fill("Add a clap pad and a closed hat pad [add-pads]");
    await page.keyboard.press("Enter");
    await expect(proposalButton(page, "Apply")).toBeEnabled({ timeout: 15_000 });
    await expect(proposal(page)).toContainText("BD");
    await proposalButton(page, "Apply").click();

    await expect(
      kit(page).getByRole("button", { name: "Audition Closed Hat", exact: true }),
    ).toBeVisible();
    expect(await sound(page, "BD")).toBe(kick);
    expect(await sound(page, "Clap")).toMatch(/no sample/i);

    // One undo takes the whole Apply back.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect(
      kit(page).getByRole("button", { name: "Audition Clap", exact: true }),
    ).toHaveCount(0);
    expect(await sound(page, "BD")).toBe(kick);
  });
});
