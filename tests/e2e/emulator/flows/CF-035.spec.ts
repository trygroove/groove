import { expect, test } from "@playwright/test";
import { walkthrough } from "../../support/walkthrough";
import { arrangement } from "../support/assistant";
import { seedRegisteredSession } from "../support/authSession";
import {
  askOption,
  askText,
  CUE,
  conversationIn,
  cuePanel,
  expectQuestion,
  memoryCard,
  sendAnswer,
  skipQuestion,
  welcome,
} from "../support/onboarding";
import { reloadPage } from "../support/reload";

/**
 * `CF-035`: a new producer meets Coproducer and opens the studio.
 *
 * Read the flow in `docs/core-flows.md`. The numbered comments are its steps,
 * in its words. This is the acceptance contract for GRV-25 (onboarding with
 * Coproducer and producer memory), and it is frozen once it lands: a later PR that
 * changes an assertion here has to say so in its body and justify it.
 *
 * **The account.** Every other spec's fresh account has skipped onboarding
 * (`seedRegisteredSession`); this one asks for an account with no profile,
 * which is what a producer who has never been through it has. It imports
 * Playwright's `test` and seeds its own account for that reason.
 *
 * **Locators** are `../support/onboarding.ts`'s, written from the spec against
 * roles and accessible names only.
 *
 * Out of scope, per the flow: what Coproducer says after onboarding, skipping the
 * whole welcome, the Memory page, memory notes, the nudge, the consented
 * validation event, and the lesson itself (GRV-43).
 *
 * Runs against the Firestore/Auth emulator because steps 8 and 9 are a real
 * reload and a real profile read.
 */

test.describe("CF-035", () => {
  // biome-ignore format: unparked by removing only test.fixme, so the frozen body keeps its lines
  test(
    "a new producer meets Coproducer and opens the studio",
    async ({ page, browserName }) => {
      await seedRegisteredSession(page, {
        label: `cf-035-${browserName}`,
        onboarded: false,
      });
      const step = walkthrough(page, {
        id: "CF-035",
        title: "A new producer meets Coproducer and opens the studio",
      });

      // 1. Open the dashboard. You are taken to the welcome instead: Coproducer
      //    introduces itself under its name, and asks what music you love,
      //    with genres to pick and a box for the artists you love. "Skip to
      //    the studio" is on screen.
      await page.goto("/projects");
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(
        welcome(page).getByRole("heading", { level: 1, name: CUE }),
      ).toBeVisible();
      await expectQuestion(page, /music do you love/i);
      await expect(askText(page, "Artists you love")).toBeVisible();
      await expect(page.getByRole("button", { name: "Skip to the studio" })).toBeVisible();
      await step("Coproducer says hello and asks what music you love");

      // 2. Pick House and Techno, type "Four Tet" in the box, and send. Your
      //    answer appears in the conversation, and Coproducer asks how much music you
      //    have made.
      await askOption(page, "House").click();
      await askOption(page, "Techno").click();
      await askText(page, "Artists you love").fill("Four Tet");
      await sendAnswer(page).click();
      await expect(conversationIn(page)).toContainText("Four Tet");
      await expectQuestion(page, /how much music have you made/i);
      await step("Answer with genres and an artist");

      // 3. Pick "Played around". Coproducer asks whether you have a goal.
      await askOption(page, "Played around").click();
      await expectQuestion(page, /goal/i);

      // 4. Skip that question. Coproducer asks what you would like to learn.
      await skipQuestion(page).click();
      await expectQuestion(page, /like to learn/i);

      // 5. Pick "Drums and beats" and send. Coproducer asks about gear.
      await askOption(page, "Drums and beats").click();
      await sendAnswer(page).click();
      await expectQuestion(page, /gear/i);

      // 6. Pick "A synth" and send. A "Saved to memory" card lists what
      //    you said: House, Techno, Four Tet, Played around, Drums and beats
      //    and A synth. Its box to share your answers is unticked. Coproducer
      //    offers a first lesson.
      await askOption(page, "A synth").click();
      await sendAnswer(page).click();
      await expect(memoryCard(page)).toBeVisible();
      for (const said of [
        "House",
        "Techno",
        "Four Tet",
        "Played around",
        "Drums and beats",
        "A synth",
      ]) {
        await expect(memoryCard(page)).toContainText(said);
      }
      await expect(memoryCard(page).getByRole("checkbox")).not.toBeChecked();
      await expect(conversationIn(page)).toContainText(/first lesson/i);
      await step("Saved to memory, and the offer of a first lesson");

      // 7. Choose Open the studio. A new project opens on the arrangement,
      //    with Coproducer's panel open and the same conversation in it: your
      //    answers, and Coproducer's offer of a first lesson.
      await page.getByRole("button", { name: "Open the studio" }).click();
      await expect(page).toHaveURL(/\/projects\/prj_[^/]+$/);
      const projectUrl = page.url();
      await arrangement(page).waitFor();
      await expect(cuePanel(page)).toBeVisible();
      // Coproducer's panel opens on its first-run notice (GRV-8) until it is
      // answered; the conversation is behind it.
      await cuePanel(page).getByRole("button", { name: "OK" }).click();
      await expect(conversationIn(cuePanel(page))).toContainText("Four Tet");
      await expect(cuePanel(page)).toContainText(/first lesson/i);
      await step("The studio opens, and the conversation carries on in Coproducer's panel");

      // 8. Reload the page. The conversation is still in Coproducer's panel.
      await reloadPage(page);
      await arrangement(page).waitFor();
      await expect(conversationIn(cuePanel(page))).toContainText("Four Tet");

      // 9. Open the dashboard. It stays on the dashboard, and lists the
      //    project.
      await page.goto("/projects");
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
      const projectId = projectUrl.split("/").pop() ?? "";
      await expect(page.locator(`a[href$="${projectId}"]`).first()).toBeVisible();
      await step("Back on the dashboard, not asked again");
    },
  );
});
