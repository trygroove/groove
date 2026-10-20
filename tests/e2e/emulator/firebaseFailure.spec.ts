import { reloadPage } from "./support/reload";
import { expect, type Page, test } from "./support/test";

/**
 * Firebase's failure states, in every gating browser (#75, PRD section 10:
 * "Network loss is visible").
 *
 * The in-memory mock backend cannot fail a save — its repository is in memory — so this
 * runs against the emulator, where taking the browser offline makes the real
 * Firestore SDK's revision-checked write fail the way it does for a producer
 * whose connection drops.
 */

const saveStatus = (page: Page) => page.locator(".save-status");
const tempo = (page: Page) => page.getByRole("spinbutton", { name: "Tempo (BPM)" });

async function setTempo(page: Page, bpm: number): Promise<void> {
  await tempo(page).fill(String(bpm));
  await tempo(page).press("Enter");
}

test.describe("Firebase failure states", () => {
  test("a save that cannot reach Firestore says so, offers Retry, and recovers", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "New Project" }).click();
    await expect(page).toHaveURL(/\/projects\/prj_/);
    await page.getByTestId("arrangement-view-ready").waitFor();
    // Nothing waiting to save yet: a fresh project is already stored.
    await expect(saveStatus(page)).toHaveAttribute("data-state", /^(idle|saved)$/);

    await context.setOffline(true);
    await setTempo(page, 128);
    // The edit is applied locally at once; only the save is waiting.
    await expect(tempo(page)).toHaveValue("128");
    await expect(saveStatus(page)).toHaveText("Save failed", { timeout: 60_000 });
    const recovery = page
      .getByRole("alert")
      .filter({ hasText: "Check your connection." });
    await expect(recovery).toBeVisible();

    await context.setOffline(false);
    // Retry, unless the queued write already went through on reconnect.
    const retry = recovery.getByRole("button", { name: "Retry" });
    if (await retry.isVisible()) await retry.click();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 30_000 });

    // The edit that was made offline is the one that persisted.
    await reloadPage(page);
    await page.getByTestId("arrangement-view-ready").waitFor();
    await expect(tempo(page)).toHaveValue("128");
  });
});
