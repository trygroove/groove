import {
  answerDisclosure,
  assistantButton,
  composer,
  conversation,
  newProject,
  panel,
  panelButton,
  scope,
} from "./support/assistant";
import { expect, test } from "./support/test";

/**
 * The assistant's conversation (GRV-26) against the real gateway: the
 * `assistantTurn` callable in the Functions emulator, answering from its
 * scripted provider (`src/assistant/emulatorProvider.ts`). A marker in the
 * message picks the script: a plain message streams a short reply, `[hang]`
 * writes one piece and waits for Stop, `[flaky]` fails once and then works,
 * `[propose]` ends in a proposal, and `[ask]` in a question for the producer
 * (GRV-42).
 */

const REPLY =
  "Here is one idea. Try a small change first, then listen to it in the loop.";

test.describe("the assistant's conversation", { tag: "@sanity" }, () => {
  test("sends, streams, stops and tries again through the gateway", async ({ page }) => {
    await newProject(page);
    await assistantButton(page).click();
    // A fresh account answers the disclosure first (GRV-8).
    await answerDisclosure(page);
    await expect(composer(page)).toBeFocused();
    await expect(scope(page)).toHaveAccessibleName("Scope: BD");

    // Send: Enter sends, the message is stamped with its scope, and the
    // reply streams in. (Stop standing in for Send is checked on the
    // [hang] turn below, which stays open until Stop: this reply finishes in
    // a few hundred milliseconds, so a check for Stop here would race it.)
    await composer(page).fill("Make it groove");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("");
    await expect(conversation(page)).toContainText("Make it groove");
    await expect(conversation(page)).toContainText(/Scope\W+BD\b/);
    await expect(conversation(page)).toContainText(REPLY);
    await expect(panelButton(page, "Send")).toBeVisible();
    await expect(conversation(page)).toHaveAttribute("aria-busy", "false");

    // Stop: the reply keeps what it wrote, and the composer has focus again.
    await composer(page).fill("Keep going [hang]");
    await page.keyboard.press("Enter");
    await expect(conversation(page)).toHaveAttribute("aria-busy", "true");
    await expect(panel(page)).toContainText("Writing…");
    await expect(panelButton(page, "Stop")).toBeVisible();
    await expect(panelButton(page, "Send")).toHaveCount(0);
    // Wait for the hang reply's first piece before stopping: a Stop that
    // beats it leaves a reply of just "Stopped.".
    await expect(conversation(page).locator(".assistant-reply").last()).toContainText(
      "Here is one idea.",
    );
    await panelButton(page, "Stop").click();
    await expect(conversation(page)).toContainText("Here is one idea. Stopped.");
    await expect(composer(page)).toBeFocused();
    await expect(panel(page)).not.toContainText("Writing…");

    // Try again: a provider failure is an inline error that offers it, and
    // the retried turn's reply takes the place of the error and of what the
    // failed turn had written.
    await composer(page).fill(`Once more [flaky] ${test.info().testId}-${Date.now()}`);
    await page.keyboard.press("Enter");
    const failure = conversation(page).getByRole("alert");
    await expect(failure).toContainText("The assistant couldn't reply.");
    await expect(failure).toContainText("Your song is unchanged");
    // What the failed turn wrote says it was cut off.
    await expect(conversation(page).locator(".assistant-reply").last()).toContainText(
      "Here is one idea. Interrupted.",
    );
    await failure.getByRole("button", { name: "Try again" }).click();
    await expect(failure).toHaveCount(0);
    await expect(conversation(page).getByText(REPLY)).toHaveCount(2);
    // The part the failed turn wrote went with the error: three replies, one
    // per message, and none left over from the failure.
    await expect(conversation(page).locator(".assistant-reply")).toHaveCount(3);
  });

  test("ends a reply in a proposal card", async ({ page }) => {
    await newProject(page);
    await assistantButton(page).click();
    await answerDisclosure(page);
    await composer(page).fill("Speed it up [propose]");
    await page.keyboard.press("Enter");
    const card = conversation(page).getByRole("region", { name: /^Proposal\b/ });
    await expect(card).toContainText(/Tempo\b.*→.*\b100 BPM/);
    await expect(card.getByRole("button", { name: "Apply" })).toBeEnabled();
  });
});

test.describe("a question the assistant asks", () => {
  test("waits above the composer and takes its answer from the number keys (GRV-42)", async ({
    page,
  }) => {
    await newProject(page);
    await assistantButton(page).click();
    await answerDisclosure(page);
    await composer(page).fill("Build me a drop [ask]");
    await page.keyboard.press("Enter");

    const card = panel(page).getByRole("region", { name: "The assistant asks" });
    await expect(card).toContainText("Where should the drop land?");
    await expect(card.getByRole("button", { name: "Bar 17" })).toHaveClass(
      /assistant-ask-suggested-option/,
    );
    // It took focus from the empty composer, so `1` picks rather than switching view.
    await expect(card).toBeFocused();
    await page.keyboard.press("1");
    await expect(card).toHaveCount(0);
    await expect(conversation(page)).toContainText(
      "Answer · Where should the drop land?",
    );
    await expect(conversation(page)).toContainText("Asked: Where should the drop land?");
    await expect(conversation(page).getByText(REPLY)).toHaveCount(1);
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  });

  test("is answered by making the change in the editor (GRV-42)", async ({ page }) => {
    await newProject(page);
    await assistantButton(page).click();
    await answerDisclosure(page);
    await composer(page).fill("Where do I start? [ask-rich]");
    await page.keyboard.press("Enter");

    const card = panel(page).getByRole("region", { name: "The assistant asks" });
    await expect(card).toContainText("What should change first?");
    await expect(card.getByRole("button", { name: "The first track" })).toContainText(
      "Track BD",
    );
    await expect(card.getByRole("button", { name: "The opening" })).toContainText(
      "Bars 1–2",
    );

    // Setting the tempo in the header answers it as the option that asked for it.
    const tempo = page.getByRole("spinbutton", { name: "Tempo (BPM)" });
    await tempo.fill("96");
    await tempo.blur();
    await expect(card).toHaveCount(0);
    await expect(conversation(page)).toContainText(
      "Slower, at 100 BPM (done in the editor)",
    );
    await expect(conversation(page).getByText(REPLY)).toHaveCount(1);
  });
});
