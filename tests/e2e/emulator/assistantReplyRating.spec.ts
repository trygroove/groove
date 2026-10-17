import { test as base } from "@playwright/test";
import { walkthrough } from "../support/walkthrough";
import {
  answerDisclosure,
  assistantButton,
  composer,
  conversation,
  newProject,
} from "./support/assistant";
import { seedRegisteredSession } from "./support/authSession";
import { expect } from "./support/test";

/**
 * Rating an assistant reply (GRV-103), against the real gateway, its scripted
 * provider and the Functions emulator: the thumbs show on hover, a thumbs-down
 * is kept on the turn through the `assistantRetention` callable, and an admin
 * finds the turn by filtering to replies rated down.
 */
const REPLY =
  "Here is one idea. Try a small change first, then listen to it in the loop.";

base.describe("rating an assistant reply", () => {
  base(
    "shows the thumbs on hover, keeps a thumbs-down, and an admin finds it",
    async ({ page }, testInfo) => {
      const session = await seedRegisteredSession(page, {
        label: `assistantreplyrating-${testInfo.project.name}`,
        admin: true,
      });
      const step = walkthrough(page, { id: "GRV-103", title: "Reply rating" });

      await newProject(page);
      await assistantButton(page).click();
      await answerDisclosure(page, "OK");
      await composer(page).fill("Make it groove");
      await page.keyboard.press("Enter");
      const reply = conversation(page).locator(".assistant-reply").last();
      await expect(reply).toContainText(REPLY);

      const thumbs = reply.getByRole("group", { name: "Rate this reply" });
      const down = thumbs.getByRole("button", { name: "Bad reply" });
      await composer(page).focus();
      await page.mouse.move(0, 0);
      await expect(thumbs).toHaveCSS("opacity", "0");
      await step("A finished reply, its thumbs out of sight");

      await reply.hover();
      await expect(thumbs).toHaveCSS("opacity", "1");
      await step("Hovering the reply shows its thumbs");

      await down.click();
      await expect(down).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(0, 0);
      await composer(page).focus();
      await expect(thumbs).toHaveCSS("opacity", "1");
      // The chosen thumb is the brightest thing beside it: a white fill.
      await expect(down).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await step("Rated down: the thumb stays, filled white");

      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: "Assistant transcripts" }),
      ).toBeVisible();
      await page.getByLabel("Account").fill(session.uid);
      await page.getByRole("combobox", { name: /^Rating/ }).selectOption("down");
      // The rating is reported after the click, so the listing may need a second look.
      const turns = page.getByRole("table", { name: "Turns" });
      await expect(async () => {
        await page.getByRole("button", { name: "Show", exact: true }).click();
        await expect(turns.getByRole("row")).toHaveCount(2, { timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await expect(turns).toContainText("Make it groove");
      await expect(turns).toContainText("Down");
      await page
        .getByRole("heading", { name: "Assistant transcripts" })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      await step("The admin page lists the turns rated down");
    },
  );
});
