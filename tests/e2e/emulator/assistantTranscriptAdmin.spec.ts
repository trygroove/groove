import { test as base } from "@playwright/test";
import { walkthrough } from "../support/walkthrough";
import {
  answerDisclosure,
  assistantButton,
  composer,
  newProject,
  proposal,
} from "./support/assistant";
import { seedRegisteredSession } from "./support/authSession";
import { expect } from "./support/test";

/**
 * A rejected assistant proposal, traced (GRV-98), against the real gateway,
 * its scripted provider and the Functions emulator: the card says which
 * change did not fit, the browser tells the kept turn why, and the admin page
 * reads that turn back through the `assistantTranscriptsAdmin` callable with
 * the rejection's issues beside the tool call that caused them.
 *
 * The producer is an admin here so one session does both halves; the rules
 * and the callable's refusals of everyone else are the unit and emulator
 * suites' (`transcriptStoreContract.ts`, `assistantTranscripts.emulator.test.ts`).
 */
const SOUND_MISSING = "The assistant tried to use a sound that isn't in your library.";

base.describe("a rejected assistant proposal", () => {
  base(
    "says why on its card, and an admin reads the kept turn's issues",
    async ({ page }, testInfo) => {
      const session = await seedRegisteredSession(page, {
        label: `assistanttranscriptadmin-${testInfo.project.name}`,
        admin: true,
      });
      const step = walkthrough(page, { id: "GRV-98", title: "Rejected proposals" });

      await newProject(page);
      await assistantButton(page).click();
      await answerDisclosure(page, "OK");
      await composer(page).fill("Add a noisy layer [misfit]");
      await page.keyboard.press("Enter");

      await expect(proposal(page)).toContainText(SOUND_MISSING, { timeout: 15_000 });
      await expect(proposal(page)).toContainText("Nothing changed.");
      await expect(proposal(page).getByRole("button", { name: "Dismiss" })).toBeVisible();
      await step("The card says which change didn't fit");

      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: "Assistant transcripts" }),
      ).toBeVisible();
      await page.getByLabel("Account").fill(session.uid);
      await page.getByLabel("Outcome").selectOption("rejected");
      await page.getByRole("button", { name: "Show", exact: true }).click();
      // The outcome is reported after the card shows, so the listing may need a second look.
      const turns = page.getByRole("table", { name: "Turns" });
      await expect(async () => {
        await page.getByRole("button", { name: "Show", exact: true }).click();
        await expect(turns.getByRole("row")).toHaveCount(2, { timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await expect(turns).toContainText("Add a noisy layer [misfit]");
      await expect(turns).toContainText("invalid_project");
      await page
        .getByRole("heading", { name: "Assistant transcripts" })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      await step("The admin page lists rejected turns with their issue codes");

      await turns.getByRole("button", { name: /^Open the turn/ }).click();
      const turn = page.getByRole("article", { name: "Turn" });
      await expect(turn).toContainText("A noisy pad underneath would add some air.");
      await expect(turn.getByRole("list", { name: "Issues" })).toContainText(
        "invalid_project in track_create",
      );
      await expect(turn.getByRole("list", { name: "Issues" })).toContainText(
        "references missing asset",
      );
      await turn.locator("summary").first().click();
      await expect(turn).toContainText('"assetId": "ast_NoisePad0000000000001"');
      await turn.scrollIntoViewIfNeeded();
      await step("The admin page opens the rejected turn beside its issues");
    },
  );
});
